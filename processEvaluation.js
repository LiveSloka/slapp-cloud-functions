/**
 * Google Cloud Function: Process Evaluation
 * 
 * Evaluates student answer sheets using approved marking schemes
 */

const {
  vertexAI,
  VERTEX_AI_DATA_SOURCE_ID,
  retryWithBackoff,
  calculateTokenCost,
  connectToDatabase,
  saveResultsToMongoDB,
  handleSaveError
} = require('./utils');

// ============================================================================
// CLOUD FUNCTION: PROCESS EVALUATION
// ============================================================================
exports.processEvaluation = async (req, res) => {
  console.log('\n🚀 ============ EVALUATION CLOUD FUNCTION TRIGGERED ============');
  console.log('   Timestamp:', new Date().toISOString());
  console.log('   Project:', process.env.GCP_PROJECT_ID);
  
  try {
    const payload = req.body;
    
    console.log('\n📋 Payload received:');
    console.log('   Exam ID:', payload.examId || '❌ MISSING');
    console.log('   Tenant ID:', payload.tenantId || '❌ MISSING');
    console.log('   Question Paper URI:', payload.questionPaperUri || '❌ MISSING');
    console.log('   Marking Scheme URI:', payload.markingSchemeUri || '❌ MISSING');
    console.log('   Students:', payload.studentAnswerSheets?.length || '❌ MISSING');
    console.log('===================================================\n');

    // Validate payload
    if (!payload.examId) {
      throw new Error('Invalid payload: examId is required');
    }
    if (!payload.tenantId) {
      throw new Error('Invalid payload: tenantId is required');
    }
    if (!payload.questionPaperUri) {
      throw new Error('Invalid payload: questionPaperUri is required');
    }
    if (!payload.markingSchemeUri) {
      throw new Error('Invalid payload: markingSchemeUri is required');
    }
    if (!payload.studentAnswerSheets || !Array.isArray(payload.studentAnswerSheets) || payload.studentAnswerSheets.length === 0) {
      throw new Error('Invalid payload: studentAnswerSheets array is required');
    }
    if (!payload.examMetadata) {
      throw new Error('Invalid payload: examMetadata is required');
    }
    
    console.log('✅ Payload validation passed');
    console.log(`   Processing ${payload.studentAnswerSheets.length} student(s)`);

    // Connect to MongoDB
    await connectToDatabase();

    console.log('\n📋 Marking Scheme URI:', payload.markingSchemeUri);
    console.log('   Vertex AI will load the marking scheme directly from GCS');

    // Process each student with Vertex AI
    console.log('\n📤 Processing evaluations with Vertex AI...');
    const allResults = {
      students: {},
      tokenUsage: { promptTokens: 0, outputTokens: 0, totalTokens: 0, totalCost: 0 },
      rawResponse: ''
    };
    
    for (const student of payload.studentAnswerSheets) {
      console.log(`\n   Processing: ${student.studentName} (Roll: ${student.rollNumber})`);
      
      try {
        const result = await retryWithBackoff(() => 
          generateStudentReportCardNewFormat(
            student,
            payload.questionPaperUri,
            payload.markingSchemeUri,
            payload.examMetadata
          ),
          3,
          2000
        );
        
        // Merge results
        if (result.students) {
          Object.assign(allResults.students, result.students);
        }
        
        // Accumulate token usage
        if (result.tokenUsage) {
          allResults.tokenUsage.promptTokens += result.tokenUsage.promptTokens || 0;
          allResults.tokenUsage.outputTokens += result.tokenUsage.outputTokens || 0;
          allResults.tokenUsage.totalTokens += result.tokenUsage.totalTokens || 0;
          allResults.tokenUsage.totalCost += result.tokenUsage.totalCost || 0;
        }
        
        // Append raw response
        if (result.rawResponse) {
          allResults.rawResponse += (allResults.rawResponse ? '\n\n---\n\n' : '') + result.rawResponse;
        }
        
        console.log(`   ✅ Completed: ${student.studentName}`);
      } catch (error) {
        console.error(`   ❌ Failed for ${student.studentName}:`, error.message);
        // Continue with next student
      }
    }
    
    console.log(`\n💰 Total Cost: $${(allResults.tokenUsage.totalCost || 0).toFixed(6)}`);
    console.log(`🎯 Students evaluated: ${Object.keys(allResults.students).length}/${payload.studentAnswerSheets.length}`);

    // Save results to MongoDB
    console.log('\n💾 Saving results to MongoDB...');
    await saveResultsToMongoDB({
      examId: payload.examId,
      tenantId: payload.tenantId,
      evaluationLevel: 'medium', // Default value for database schema compatibility
      results: allResults,
      createdBy: payload.createdBy || 'cloud-function',
      rawResponse: allResults.rawResponse
    });
    console.log('✅ Results saved successfully');

    // Respond to Cloud Tasks
    res.status(200).json({
      success: true,
      message: 'Evaluation completed and saved to database',
      examId: payload.examId,
      studentsProcessed: Object.keys(allResults.students).length,
      totalStudents: payload.studentAnswerSheets.length
    });

  } catch (error) {
    console.error('\n❌ Error processing evaluation:', error);
    console.error('   Stack:', error.stack);
    
    // Save error status to MongoDB
    try {
      await connectToDatabase();
      await handleSaveError({
        examId: req.body?.examId,
        tenantId: req.body?.tenantId,
        error: error.message
      });
    } catch (dbError) {
      console.error('❌ Failed to save error status:', dbError);
    }

    // Return 200 to acknowledge task (not 500 which would retry)
    res.status(200).json({
      success: false,
      message: 'Evaluation failed',
      error: error.message,
      examId: req.body?.examId
    });
  }
};

// ============================================================================
// EVALUATION HELPER FUNCTIONS
// ============================================================================

/**
 * Generate report card for a single student using Vertex AI (new format)
 */
async function generateStudentReportCardNewFormat(
  student,
  questionPaperUri,
  markingSchemeUri,
  examMetadata
) {
  const subjectName = examMetadata.subjectName;
  const className = examMetadata.className;
  const examTypeName = examMetadata.examTypeName;
  
  // Get Gemini 2.5 Flash model from Vertex AI with data source (retrieval) configuration
  const projectId = process.env.GCP_PROJECT_ID || 'slapp-478005';
  const location = 'global';
  const dataStoreName = `projects/${projectId}/locations/${location}/collections/default_collection/dataStores/${VERTEX_AI_DATA_SOURCE_ID}`;
  
  console.log('   🔍 Data Store Resource Name:', dataStoreName);
  
  const generativeModel = vertexAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    tools: [{
      retrieval: {
        vertexAiSearch: {
          datastore: dataStoreName
        }
      }
    }]
  });

  // Prepare file parts: marking scheme (TXT) and student answer sheet only
  // Note: Question paper is NOT sent - LLM should read the marking scheme which contains all question details
  const fileParts = [
    {
      fileData: {
        fileUri: markingSchemeUri,
        mimeType: 'text/plain'
      }
    },
    {
      fileData: {
        fileUri: student.answerSheetUri,
        mimeType: 'application/pdf'
      }
    }
  ];

  // Build prompt with strict marking scheme usage
  const prompt = buildEvaluationPromptNewFormat(
    student,
    subjectName,
    className,
    examTypeName
  );

  console.log('   📝 Prompt length:', prompt.length, 'characters');
  console.log('   📎 Files attached:', fileParts.length, '(marking scheme + answer sheet)');
  console.log('   🔍 Data Source (Retrieval) enabled:', VERTEX_AI_DATA_SOURCE_ID);

  // Call Vertex AI with data source retrieval enabled
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
    ],
    tools: [{
      retrieval: {
        vertexAiSearch: {
          datastore: dataStoreName
        }
      }
    }]
  };
  
  const result = await generativeModel.generateContent(request);
  const responseTime = Date.now() - startTime;

  console.log('   ⏱️  Response time:', responseTime, 'ms');

  const response = result.response;
  const text = response.candidates[0].content.parts[0].text;

  console.log('   📄 Response text preview (first 500 chars):', text.substring(0, 500));
  console.log('   📄 Response text length:', text.length, 'characters');

  // Save raw response before parsing
  const rawResponseText = String(text || '').trim();

  // Parse JSON response using shared repair utility
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
            continue;
          }
          if (char === '\\') {
            result += char;
            escapeNext = true;
            continue;
          }
          if (char === '"') {
            inString = !inString;
            result += char;
            continue;
          }
          if (inString) {
            if (char === '\n') result += '\\n';
            else if (char === '\r') result += '\\r';
            else if (char === '\t') result += '\\t';
            else if (char.charCodeAt(0) < 32) {
              result += `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`;
            } else {
              result += char;
            }
          } else {
            result += char;
          }
        }
        repaired = result;
        
        // Multiple parse attempts with error-specific fixes
        let parseAttempts = 0;
        const maxAttempts = 5;
        
        while (parseAttempts < maxAttempts) {
          try {
            return JSON.parse(repaired);
          } catch (parseError) {
            parseAttempts++;
            const errorMessage = parseError.message || '';
            const positionMatch = errorMessage.match(/position (\d+)/);
            
            if (positionMatch && parseAttempts < maxAttempts) {
              const position = parseInt(positionMatch[1]);
              
              if (errorMessage.includes("Expected ',' or '}'")) {
                // Try to add missing comma
                if (position < repaired.length) {
                  const charAtPos = repaired[position];
                  const beforeChar = position > 0 ? repaired[position - 1] : '';
                  
                  // If we have a value before and a quote/brace after, add comma
                  if ((beforeChar === '"' || /[\w\d}]/.test(beforeChar)) && 
                      (charAtPos === '"' || charAtPos === '}' || charAtPos === ']')) {
                    repaired = repaired.substring(0, position) + ',' + repaired.substring(position);
                    continue;
                  }
                  
                  // Look backwards for string end to add comma
                  for (let i = position - 1; i >= Math.max(0, position - 50); i--) {
                    if (repaired[i] === '"' && repaired[i - 1] !== '\\') {
                      let j = i + 1;
                      while (j < repaired.length && /\s/.test(repaired[j])) j++;
                      if (j < repaired.length && (repaired[j] === '"' || repaired[j] === '{' || repaired[j] === '[')) {
                        repaired = repaired.substring(0, j) + ',' + repaired.substring(j);
                        break;
                      }
                    }
                  }
                }
              } else if (errorMessage.includes("Bad control character")) {
                repaired = repaired.replace(/[\x00-\x1F]/g, (char) => {
                  return `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`;
                });
              } else {
                break;
              }
            } else {
              break;
            }
          }
        }
        
        // Final attempt
        try {
          return JSON.parse(repaired);
        } catch (finalError) {
          throw new Error(`Failed to parse JSON after ${maxAttempts} repair attempts: ${finalError.message}`);
        }
      };
    }
    
    evaluationData = parseJSONWithRepair(rawResponseText);
    console.log('   ✅ Successfully parsed JSON response');
  } catch (parseError) {
    console.error('   ⚠️ JSON parsing failed:', parseError.message);
    throw new Error(`Failed to parse JSON response: ${parseError.message}`);
  }

  // Extract token usage
  const usageMetadata = result.response.usageMetadata || {};
  const tokenUsage = calculateTokenCost(usageMetadata);

  // Format response to match expected structure for saveResultsToMongoDB
  const studentsData = {};
  const studentResult = evaluationData.students?.[0];
  
  if (studentResult) {
    // Transform questions to ensure compatibility with backend format
    const transformedQuestions = studentResult.questions?.map(q => {
      const marksAwarded = q.marksAwarded !== undefined ? q.marksAwarded : (q.awarded_marks !== undefined ? q.awarded_marks : 0);
      let reasonForMarksAllocation = q.reasonForMarksAllocation || '';
      
      // Build reason from new format fields if available
      if (q.why_marks_awarded && Array.isArray(q.why_marks_awarded)) {
        reasonForMarksAllocation = q.why_marks_awarded.join('; ');
      }
      
      return {
        questionNumber: q.questionNumber,
        section: q.section,
        questionType: q.questionType,
        maxMarks: q.maxMarks || q.out_of || 0,
        marksAwarded: marksAwarded,
        reasonForMarksAllocation: reasonForMarksAllocation,
        // Include new format fields
        awarded_marks: q.awarded_marks,
        out_of: q.out_of,
        why_marks_awarded: q.why_marks_awarded,
        deductions: q.deductions,
        tiered_feedback: q.tiered_feedback,
        value_points_matched: q.value_points_matched
      };
    }) || [];
    
    // Use studentId as key (convert to string) for compatibility with saveResultsToMongoDB
    const studentIdKey = student.studentId ? student.studentId.toString() : student.studentName;
    
    studentsData[studentIdKey] = {
      studentName: studentResult.studentName || student.studentName,
      rollNumber: studentResult.rollNumber || student.rollNumber,
      questions: transformedQuestions,
      overallFeedback: studentResult.overallFeedback || {},
      overallRubrics: studentResult.overallRubrics || {}
    };
  }

  return {
    students: studentsData,
    tokenUsage,
    rawResponse: rawResponseText
  };
}

/**
 * Build evaluation prompt with strict marking scheme usage
 */
function buildEvaluationPromptNewFormat(student, subjectName, className, examTypeName) {
  return `You are an expert CBSE examiner evaluating a student's answer sheet.

**Subject:** ${subjectName}
**Class:** ${className}
**Exam Type:** ${examTypeName}
**Student:** ${student.studentName} (Roll: ${student.rollNumber})

**CRITICAL: STRICT EVALUATION REQUIREMENTS**

Two files have been provided:
1. **Marking Scheme (TXT)** - Contains the official marking scheme with ALL question details, value points, step marks, correct answers, and marking criteria in a formatted text format. This file includes:
   - All question numbers and question text
   - Section names and organization
   - Maximum marks for each question
   - Value points for non-MCQ questions
   - Step marks distribution
   - Correct answers and model answers
   - Question types (MCQ, VSA, SA, LA, etc.)
2. **Student Answer Sheet (PDF)** - Contains the student's answers to be evaluated

**You MUST:**
- Read and understand the marking scheme text file completely - it contains ALL the information you need about the questions
- Use the marking scheme as the STRICT and ONLY reference for awarding marks
- Extract question details (question numbers, sections, question text, question types) from the marking scheme
- Compare the student's answers (from the answer sheet PDF) against the marking scheme
- **CRITICAL: STEP-BY-STEP EVALUATION REQUIRED**
  - For each question in the marking scheme, you MUST evaluate EACH value point/step individually
  - For each value point (step) in the marking scheme:
    1. Check if the student ATTEMPTED this step (look for the step's content in their answer)
    2. Check if the step is CORRECT by verifying:
       - The student's answer contains the expected concepts/key terms from expected_ocr_match field
       - The step logic/calculation is correct
       - The step follows the description requirements
    3. **IF STEP IS CORRECT:** Award the full marks for that step (marks value from value point, typically 0.5)
    4. **IF STEP IS WRONG OR MISSING:** Award 0 marks for that step
  - Sum up all the marks from correctly answered steps to get the total marks for the question
  - Do NOT award marks for incorrect or missing steps
- For MCQ questions: Award full marks ONLY if the student selected the correct option specified in the marking scheme
- Use the step marks distribution exactly as specified in the marking scheme
- Do NOT award marks for content not in the marking scheme, even if it seems correct
- Do NOT exceed the maximum marks specified for each question in the marking scheme
- Ensure the question numbers, sections, and question types match exactly with the marking scheme

**IMPORTANT: Choice-Based Questions (Questions with 'OR')**

- In descriptive, short answer, or long answer questions, you may encounter questions marked with "OR" (e.g., "Question 5(a) OR 5(b)")
- The "OR" indicates that students have a CHOICE to answer EITHER of the questions
- When evaluating:
  - Check which question the student has attempted (they may have attempted one, both, or neither)
  - If the student attempted one of the choice questions, evaluate ONLY that question using the corresponding marking scheme
  - If the student attempted both choice questions, evaluate ONLY the first one they answered (or the better one, but still use the marking scheme for that specific question)
  - Do NOT award marks for both choice questions - only one should be evaluated
  - Match the student's attempted question number with the correct marking scheme entry
  - Be very careful to identify which specific question (e.g., 5(a) vs 5(b)) the student answered

**Grounding Datastore Reference:**

- A Vertex AI Search datastore is available and enabled for this evaluation
- The datastore contains official CBSE marking scheme documents, sample question papers, and marking scheme examples
- You can use the datastore to:
  - Reference evaluation methodology and guidelines not explicitly covered in the provided marking scheme
  - Understand marking standards and practices for edge cases
  - Get clarification on how to handle situations not fully addressed in the marking scheme
  - Reference subject-specific evaluation criteria and best practices
- While the provided marking scheme text file is the PRIMARY and STRICT reference, the datastore can provide additional context and guidance for evaluation methodology
- Always prioritize the provided marking scheme, but use the datastore for supplementary reference when needed

**Evaluation Process:**
1. Read the marking scheme text file completely - it contains ALL question details including question numbers, question text, sections, question types, maximum marks, value points (with step_id, description, expected_ocr_match, marks), step marks, and correct answers
2. Read the student's answer sheet PDF
3. For each question listed in the marking scheme, identify the corresponding answer in the student's answer sheet
4. **For each question, evaluate EACH value point/step individually:**
   - Check if the student attempted the step
   - Verify correctness using expected_ocr_match and description fields from the marking scheme
   - Award marks ONLY for correct steps
   - Award 0 marks for incorrect or missing steps
5. Calculate total marks for each question = Sum of marks from all correctly answered steps
6. Document which value points/steps were correct (and awarded marks) and which were wrong/missing (and why marks were deducted)

**Output Format:**

Return ONLY valid JSON. NO markdown code blocks, NO explanations, NO text before or after.

Return a JSON object with ALL questions (MCQ and Non-MCQ) in this exact format:

{
  "students": [
    {
      "studentName": "${student.studentName}",
      "rollNumber": "${student.rollNumber}",
      "questions": [
        {
          "questionNumber": "1",
          "section": "Section name",
          "questionType": "MCQ | VSA | SA | LA | Case | Map | Grammar | Writing | Numericals/Derivation",
          "maxMarks": 10,
          "marksAwarded": 8,
          "awarded_marks": 8,
          "out_of": 10,
          "why_marks_awarded": [
            "✓ Matched value points: <list the exact ideas/steps credited>",
            "✓ Method/working shown: <brief note>",
            "✓ Format/presentation credit: <if any>"
          ],
          "deductions": [
            { "reason": "Spelling/grammar issue", "marks": 0.5 },
            { "reason": "Missing a critical step", "marks": 1 }
          ],
          "tiered_feedback": {
            "easy": "...",
            "medium": "...",
            "strict": "...",
            "very_strict": "..."
          },
          "value_points_matched": ["point1", "point2"]
        }
      ]
    }
  ]
}`;
}

