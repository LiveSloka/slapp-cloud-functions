/**
 * Google Cloud Function: Simple Answer Sheet Evaluation
 * 
 * Evaluates a single answer sheet against a marking scheme
 * Returns marks for each step in value points
 */

const {
  vertexAI,
  retryWithBackoff,
  calculateTokenCost,
  connectToDatabase,
  saveAnswerSheetEvaluationToMongoDB
} = require('./utils');

// ============================================================================
// CLOUD FUNCTION: SIMPLE EVALUATION
// ============================================================================
exports.processSimpleEvaluation = async (req, res) => {
  console.log('\n🚀 ============ SIMPLE EVALUATION TRIGGERED ============');
  console.log('   Timestamp:', new Date().toISOString());
  
  try {
    const payload = req.body;
    
    console.log('\n📋 Payload received:');
    console.log('   Marking Scheme TXT URI:', payload.markingSchemeTextUri || '❌ MISSING');
    console.log('   Answer Sheet URI:', payload.answerSheetUri || '❌ MISSING');
    console.log('   Student Name:', payload.studentName || 'Student');
    console.log('===================================================\n');

    // Validate payload
    if (!payload.markingSchemeTextUri) {
      throw new Error('Invalid payload: markingSchemeTextUri is required');
    }
    if (!payload.answerSheetUri) {
      throw new Error('Invalid payload: answerSheetUri is required');
    }

    console.log('✅ Payload validation passed');

    // Connect to MongoDB (if needed)
    await connectToDatabase();

    // Generate evaluation using Vertex AI
    console.log('\n📤 Processing evaluation with Vertex AI...');
    
    const result = await retryWithBackoff(() => 
      evaluateAnswerSheetSimple(
        payload.markingSchemeTextUri,
        payload.answerSheetUri,
        payload.studentName || 'Student'
      ),
      3,
      2000
    );

    console.log('✅ Evaluation completed successfully');
    
    // Save evaluation results to database
    // Note: questionPaperUri needs to be extracted from markingSchemeTextUri or passed separately
    // For now, we'll try to extract it from the payload or use empty string
    try {
      // Try to extract questionPaperUri from payload or derive it
      let questionPaperUri = payload.questionPaperUri;
      
      // If not provided, we can't save it properly, but still try to save with empty string
      // The backend controller should pass questionPaperUri in the payload
      if (!questionPaperUri) {
        console.log('   ⚠️  questionPaperUri not provided in payload, saving with empty string');
      }
      
      const savedEvaluation = await saveAnswerSheetEvaluationToMongoDB({
        tenantId: payload.tenantId,
        questionPaperUri: questionPaperUri || '',
        answerSheetUri: payload.answerSheetUri,
        studentName: payload.studentName || 'Student',
        evaluationData: result.evaluationData,
        tokenUsage: result.tokenUsage,
        rawResponse: result.rawResponse,
        createdBy: payload.createdBy || 'system'
      });
      console.log(`   ✅ Evaluation saved to database: ${savedEvaluation._id}`);
    } catch (saveError) {
      console.error('   ⚠️  Failed to save evaluation to database:', saveError.message);
      // Don't fail the request if save fails, just log the error
    }
    
    res.status(200).json({
      success: true,
      message: 'Answer sheet evaluated successfully',
      data: result.evaluationData,
      tokenUsage: result.tokenUsage
    });

  } catch (error) {
    console.error('❌ Error in processSimpleEvaluation:', error);
    res.status(200).json({ 
      success: false, 
      message: error.message 
    });
  }
};

/**
 * Evaluate answer sheet with simple step-by-step marking
 */
async function evaluateAnswerSheetSimple(markingSchemeTextUri, answerSheetUri, studentName) {
  const generativeModel = vertexAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    generationConfig: {
      maxOutputTokens: 64000,
      temperature: 0.1
    }
  });

  // Prepare file parts
  const fileParts = [
    {
      fileData: {
        fileUri: markingSchemeTextUri,
        mimeType: 'text/plain'
      }
    },
    {
      fileData: {
        fileUri: answerSheetUri,
        mimeType: 'application/pdf'
      }
    }
  ];

  // Simple prompt for step-by-step evaluation
  const prompt = `You are an expert academic evaluator. Your task is to evaluate a student's answer sheet against the provided marking scheme.

**MARKING SCHEME FILE:** The first file contains the marking scheme with value points for each question. Each value point has:
- step_id: Step number
- description: What the step should contain
- expected_ocr_match: Key terms/numbers to look for
- marks: Marks for this step (typically 0.5)

**ANSWER SHEET FILE:** The second file contains the student's scanned answer sheet.

**YOUR TASK:**
1. For each question in the marking scheme, evaluate the student's answer step by step
2. For each value point (step) in the marking scheme:
   - Check if the student's answer contains the expected content
   - Award marks (0.5) if the step is present and correct, 0 if missing or incorrect
3. Calculate total marks for each question by summing all step marks
4. Return ONLY the evaluation results in the specified JSON format

**OUTPUT FORMAT:**
Return ONLY valid JSON. NO markdown code blocks, NO explanations, NO text before or after.

{
  "studentName": "${studentName}",
  "questions": [
    {
      "questionNumber": "1",
      "steps": [
        {
          "step_id": 1,
          "marksAwarded": 0.5,
          "description": "Step description from marking scheme"
        },
        {
          "step_id": 2,
          "marksAwarded": 0.5,
          "description": "Step description from marking scheme"
        }
      ],
      "totalMarks": 1.0
    },
    {
      "questionNumber": "2",
      "steps": [
        {
          "step_id": 1,
          "marksAwarded": 0.5,
          "description": "Step description from marking scheme"
        },
        {
          "step_id": 2,
          "marksAwarded": 0.0,
          "description": "Step description from marking scheme"
        }
      ],
      "totalMarks": 0.5
    }
  ],
  "grandTotal": 1.5
}

**CRITICAL REQUIREMENTS:**
1. Evaluate ALL questions from the marking scheme
2. For each question, evaluate ALL value points (steps)
3. Award 0.5 marks for each correct step, 0 for incorrect/missing steps
4. Calculate total marks per question by summing step marks
5. Calculate grandTotal by summing all question totals
6. Return ONLY the JSON, no other text`;

  console.log('   📝 Prompt length:', prompt.length, 'characters');
  console.log('   📎 Files attached:', fileParts.length, '(marking scheme + answer sheet)');

  // Call Vertex AI
  const startTime = Date.now();
  const request = {
    contents: [
      {
        role: 'user',
        parts: [
          { text: prompt },
          ...fileParts
        ]
      }
    ]
  };
  
  const result = await generativeModel.generateContent(request);
  const responseTime = Date.now() - startTime;

  console.log('   ⏱️  Response time:', responseTime, 'ms');

  const response = result.response;
  
  // Check if response has candidates
  if (!response.candidates || response.candidates.length === 0) {
    console.error('   ❌ No candidates in response:', JSON.stringify(response, null, 2));
    throw new Error('No candidates returned from Vertex AI');
  }
  
  // Check if candidate has content and parts
  if (!response.candidates[0].content || !response.candidates[0].content.parts || response.candidates[0].content.parts.length === 0) {
    console.error('   ❌ No content parts in candidate:', JSON.stringify(response.candidates[0], null, 2));
    throw new Error('No content parts in Vertex AI response');
  }
  
  const text = response.candidates[0].content.parts[0].text;

  if (!text) {
    console.error('   ❌ No text in response parts:', JSON.stringify(response.candidates[0].content.parts, null, 2));
    throw new Error('No text content in Vertex AI response');
  }

  console.log('   📄 Response text preview (first 500 chars):', text.substring(0, 500));

  // Parse JSON response
  const rawResponseText = String(text || '').trim();
  
  let evaluationData;
  try {
    // Try to use shared JSON repair utility from backend
    let parseJSONWithRepair;
    try {
      const jsonRepair = require('../Backend/utils/jsonRepair');
      parseJSONWithRepair = jsonRepair.parseJSONWithRepair;
    } catch (requireError) {
      // Fallback: use enhanced inline repair functions
      parseJSONWithRepair = (rawText) => {
        if (!rawText || typeof rawText !== 'string') {
          throw new Error('Invalid raw text provided');
        }
        
        let repaired = rawText.trim();
        
        // Remove markdown code blocks
        repaired = repaired.replace(/```json\s*\n?/gi, '').replace(/```\s*\n?/g, '').trim();
        
        // Find actual JSON boundaries
        const firstBrace = repaired.indexOf('{');
        const lastBrace = repaired.lastIndexOf('}');
        if (firstBrace >= 0 && lastBrace > firstBrace) {
          repaired = repaired.substring(firstBrace, lastBrace + 1);
        }
        
        // Fix unquoted property names
        repaired = repaired.replace(/([{,]\s*)([a-zA-Z_$][a-zA-Z0-9_$]*)\s*:/g, '$1"$2":');
        
        // Remove trailing commas
        repaired = repaired.replace(/,(\s*[}\]])/g, '$1');
        
        // Fix control characters in strings
        let inString = false;
        let escapeNext = false;
        let result = '';
        for (let i = 0; i < repaired.length; i++) {
          const char = repaired[i];
          if (escapeNext) {
            result += char;
            escapeNext = false;
          } else if (char === '\\') {
            result += char;
            escapeNext = true;
          } else if (char === '"') {
            inString = !inString;
            result += char;
          } else if (inString && (char === '\n' || char === '\r' || char === '\t')) {
            result += ' ';
          } else {
            result += char;
          }
        }
        
        return JSON.parse(result);
      };
    }
    
    evaluationData = parseJSONWithRepair(rawResponseText);
  } catch (parseError) {
    console.error('   ❌ Failed to parse JSON:', parseError.message);
    console.error('   📄 Raw response (first 1000 chars):', rawResponseText.substring(0, 1000));
    throw new Error(`Failed to parse evaluation response: ${parseError.message}`);
  }

  // Calculate token usage
  const tokenUsage = calculateTokenCost(response.usageMetadata || {});

  console.log('   ✅ Evaluation parsed successfully');
  console.log(`   📊 Questions evaluated: ${evaluationData.questions?.length || 0}`);
  console.log(`   💰 Token cost: $${tokenUsage.totalCost.toFixed(4)}`);

  return {
    evaluationData,
    tokenUsage,
    rawResponse: rawResponseText
  };
}

