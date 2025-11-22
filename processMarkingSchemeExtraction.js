/**
 * Google Cloud Function: Process Marking Scheme Extraction
 * 
 * Extracts marking scheme from question papers using Vertex AI
 */

const {
  vertexAI,
  VERTEX_AI_DATA_SOURCE_ID,
  retryWithBackoff,
  calculateTokenCost,
  connectToDatabase,
  saveMarkingSchemeToMongoDB,
  saveQuestionPaperToMongoDB
} = require('./utils');

// ============================================================================
// CLOUD FUNCTION: PROCESS MARKING SCHEME EXTRACTION
// ============================================================================
exports.processMarkingSchemeExtraction = async (req, res) => {
  console.log('\n🚀 ============ MARKING SCHEME EXTRACTION TRIGGERED ============');
  console.log('   Timestamp:', new Date().toISOString());
  try {
    console.log('   req.method:', req.method);
    console.log('   content-type:', req.headers?.['content-type']);
    const hasParsedBody = !!(req.body && typeof req.body === 'object' && Object.keys(req.body).length > 0);
    let payload = {};
    if (hasParsedBody) {
      payload = req.body;
    } else {
      try {
        const raw = req.rawBody ? req.rawBody.toString() : '';
        payload = raw ? JSON.parse(raw) : {};
      } catch (e) {
        console.warn('   ⚠️ Could not parse rawBody as JSON:', e.message);
        payload = {};
      }
    }
    console.log('   payload keys:', Object.keys(payload || {}));
    
    if (!payload.questionPaperUri) {
      throw new Error('Invalid payload: questionPaperUri is required');
    }

    await connectToDatabase();

    // Configure Vertex AI model with retrieval
    const projectId = process.env.GCP_PROJECT_ID || 'slapp-478005';
    const location = 'global';
    const dataStoreName = `projects/${projectId}/locations/${location}/collections/default_collection/dataStores/${VERTEX_AI_DATA_SOURCE_ID}`;

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

    // Build extraction prompt
    const language = (payload.language || 'english').toLowerCase();
    const languageNames = {
      'english': 'English',
      'hindi': 'Hindi (हिंदी)',
      'kannada': 'Kannada (ಕನ್ನಡ)',
      'telugu': 'Telugu (తెలుగు)',
      'tamil': 'Tamil (தமிழ்)',
      'malayalam': 'Malayalam (മലയാളം)',
      'marathi': 'Marathi (मराठी)',
      'bengali': 'Bengali (বাংলা)',
      'gujarati': 'Gujarati (ગુજરાતી)',
      'punjabi': 'Punjabi (ਪੰਜਾਬੀ)',
      'other': 'English'
    };
    const languageName = languageNames[language] || 'English';

    const prompt = `You are analyzing a question paper to extract the marking scheme.

**Context**
Subject: ${payload.subjectName || 'N/A'}
Class: ${payload.className || 'N/A'}
Language: ${languageName}

**CRITICAL: Datastore Reference Requirements**

You MUST consult the following documents from the Vertex AI Search datastore (all files are indexed and available):

1. **"CBSE Marking Scheme" Document:**
   - This file contains official CBSE marking prompts and guidelines on how to construct marking schemes
   - Use this as your PRIMARY reference for marking scheme structure, value point allocation, step-marking rules, and formatting standards
   - Apply the marking scheme construction guidelines from this document consistently throughout your extraction

2. **Sample Marks Scheme and Question Papers Examples:**
   - Refer to the Sample Marks Scheme files and corresponding Question Papers Examples for the subject: **${payload.subjectName || 'N/A'}**
   - These files contain official CBSE question papers and their marking schemes for this specific subject
   - Use these files to understand:
     - The expected structure and format of marking schemes
     - How value points are allocated for different question types
     - Step-wise marking distribution patterns
     - Acceptable answer formats and variations
     - Subject-specific marking criteria

3. **Extraction Process:**
   - FIRST: Construct your marking scheme in line with the Sample Marks Scheme files for ${payload.subjectName || 'the subject'} from the datastore
   - Ensure your marking scheme structure matches the official CBSE marking scheme format found in the Sample Marks Scheme files
   - THEN: Extract the marking scheme from the provided question paper
   - Apply the guidelines from the "CBSE Marking Scheme" document for consistency

**Grounding Requirement:**
- In addition to the question paper provided, you MUST actively search and reference:
  - The "CBSE Marking Scheme" document for marking scheme construction methodology
  - Sample Marks Scheme and Question Papers Examples for ${payload.subjectName || 'the subject'} to align your extraction
  - Apply the rules, structure, and guidance from these documents consistently

**Instructions:**
- Extract ALL questions from the question paper
- For each question, identify:
  - Question number
  - Section name (e.g., "Section A", "Section B")
  - Question type (MCQ, VSA, SA, LA, etc.)
  - Maximum marks
  - For MCQ: Extract all options (A, B, C, D) and identify the correct option. DO NOT include valuePoints or modelAnswer for MCQs.
  - For non-MCQ: Extract value points as an array of objects. Each value point MUST be worth exactly 0.5 marks.
    - Each value point should have: step_id (1, 2, 3...), description (action/step taken), expected_ocr_match (key terms/numbers to look for), marks (always 0.5)
    - If a question is worth N marks, create exactly 2N value points (each worth 0.5 marks)
    - Example: 3 marks question = 6 value points (6 × 0.5 = 3)
  - Question text (brief description)
- **CRITICAL: Internal Choice Questions Handling:**
  - If a question has internal choices (e.g., "Answer part (a) OR part (b)" or "Answer both (a) and (b)"), you MUST create SEPARATE question entries for EACH part
  - For example, if Question 33 has parts (a) and (b), create TWO separate entries:
    - One entry with questionNumber: "33 part a" (or "33(a)") with its own marks and valuePoints
    - Another entry with questionNumber: "33 part b" (or "33(b)") with its own marks and valuePoints
  - Each part of an internal choice question MUST have its own complete valuePoints array based on the marks allocated to that specific part
  - Do NOT combine value points for multiple parts - each part gets its own separate value points
  - Example: If Question 33 part (a) is worth 3 marks, create 6 value points (0.5 each) for part (a). If part (b) is worth 3 marks, create 6 separate value points (0.5 each) for part (b).
- Group questions by sections
- Calculate total marks for each section
- Calculate overall total marks
- DO NOT include modelAnswer or model_answer_latex fields - they are NOT required

**Output Format:**

Return ONLY valid JSON. NO markdown code blocks, NO explanations, NO text before or after.

{
  "examTitle": "Exam title from question paper",
  "totalMarks": 100,
  "sections": [
    {
      "sectionName": "Section A",
      "sectionTotalMarks": 25,
      "questions": [
        {
          "questionNumber": "1",
          "questionText": "Brief question description",
          "questionType": "MCQ",
          "marks": 1,
          "options": [
            {"option": "A", "text": "Option A text"},
            {"option": "B", "text": "Option B text"},
            {"option": "C", "text": "Option C text"},
            {"option": "D", "text": "Option D text"}
          ],
          "correctOption": "A",
          "correctAnswer": "Concise correct answer (max 50 chars)",
          "valuePoints": [],
          "stepMarks": []
        },
        {
          "questionNumber": "2",
          "questionText": "Brief question description",
          "questionType": "SA",
          "marks": 2,
          "options": [],
          "correctOption": "",
          "correctAnswer": "Concise correct answer (max 50 chars)",
          "valuePoints": [
            {
              "step_id": 1,
              "description": "Action or step taken (e.g., 'Substitute values into formula')",
              "expected_ocr_match": "Key numbers or terms to look for in student handwriting",
              "marks": 0.5
            },
            {
              "step_id": 2,
              "description": "Next step description",
              "expected_ocr_match": "Expected terms/numbers",
              "marks": 0.5
            },
            {
              "step_id": 3,
              "description": "Next step description",
              "expected_ocr_match": "Expected terms/numbers",
              "marks": 0.5
            },
            {
              "step_id": 4,
              "description": "Final step description",
              "expected_ocr_match": "Expected terms/numbers",
              "marks": 0.5
            }
          ],
          "stepMarks": [0.5, 0.5, 0.5, 0.5]
        },
        {
          "questionNumber": "33 part a",
          "questionText": "Question 33 part (a) description",
          "questionType": "LA",
          "marks": 3,
          "options": [],
          "correctOption": "",
          "correctAnswer": "Concise correct answer for part (a)",
          "valuePoints": [
            {
              "step_id": 1,
              "description": "First step for part (a)",
              "expected_ocr_match": "Key terms/numbers for part (a)",
              "marks": 0.5
            },
            {
              "step_id": 2,
              "description": "Second step for part (a)",
              "expected_ocr_match": "Expected terms/numbers",
              "marks": 0.5
            },
            {
              "step_id": 3,
              "description": "Third step for part (a)",
              "expected_ocr_match": "Expected terms/numbers",
              "marks": 0.5
            },
            {
              "step_id": 4,
              "description": "Fourth step for part (a)",
              "expected_ocr_match": "Expected terms/numbers",
              "marks": 0.5
            },
            {
              "step_id": 5,
              "description": "Fifth step for part (a)",
              "expected_ocr_match": "Expected terms/numbers",
              "marks": 0.5
            },
            {
              "step_id": 6,
              "description": "Final step for part (a)",
              "expected_ocr_match": "Expected terms/numbers",
              "marks": 0.5
            }
          ],
          "stepMarks": [0.5, 0.5, 0.5, 0.5, 0.5, 0.5]
        },
        {
          "questionNumber": "33 part b",
          "questionText": "Question 33 part (b) description",
          "questionType": "LA",
          "marks": 3,
          "options": [],
          "correctOption": "",
          "correctAnswer": "Concise correct answer for part (b)",
          "valuePoints": [
            {
              "step_id": 1,
              "description": "First step for part (b)",
              "expected_ocr_match": "Key terms/numbers for part (b)",
              "marks": 0.5
            },
            {
              "step_id": 2,
              "description": "Second step for part (b)",
              "expected_ocr_match": "Expected terms/numbers",
              "marks": 0.5
            },
            {
              "step_id": 3,
              "description": "Third step for part (b)",
              "expected_ocr_match": "Expected terms/numbers",
              "marks": 0.5
            },
            {
              "step_id": 4,
              "description": "Fourth step for part (b)",
              "expected_ocr_match": "Expected terms/numbers",
              "marks": 0.5
            },
            {
              "step_id": 5,
              "description": "Fifth step for part (b)",
              "expected_ocr_match": "Expected terms/numbers",
              "marks": 0.5
            },
            {
              "step_id": 6,
              "description": "Final step for part (b)",
              "expected_ocr_match": "Expected terms/numbers",
              "marks": 0.5
            }
          ],
          "stepMarks": [0.5, 0.5, 0.5, 0.5, 0.5, 0.5]
        }
      ]
    }
  ]
}

**CRITICAL JSON REQUIREMENTS:**
1. Return ONLY valid, parseable JSON. NO markdown code blocks (three backticks), NO explanations, NO text before or after.
2. Start with { and end with }. Ensure all braces, brackets, and quotes are properly closed.
3. All string values must be properly escaped:
   - Use \\" for quotes inside strings
   - Use \\n for newlines, \\t for tabs, \\r for carriage returns
   - Escape ALL control characters (characters with ASCII code < 32) as \\uXXXX
   - Do NOT include literal newlines, tabs, or other control characters in string values
4. NO trailing commas before } or ].
5. All property names must be in double quotes.
6. Ensure the JSON is complete and well-formed.`;

    // Call Vertex AI with retry logic
    console.log('\n📤 Calling Vertex AI for marking scheme extraction...');
    const startTime = Date.now();
    
    const result = await retryWithBackoff(async () => {
      const response = await generativeModel.generateContent({
        contents: [{
          role: 'user',
          parts: [
            { text: prompt },
            {
              fileData: {
                fileUri: payload.questionPaperUri,
                mimeType: 'application/pdf'
              }
            }
          ]
        }],
        tools: [{
          retrieval: {
            vertexAiSearch: {
              datastore: dataStoreName
            }
          }
        }]
      });
      return response;
    }, 3, 2000);

    const responseTime = Date.now() - startTime;
    console.log(`   ⏱️  Response time: ${responseTime}ms`);

    const text = result.response.candidates[0].content.parts[0].text;
    const rawResponseText = String(text || '').trim();
    
    console.log('   📄 Response text length:', rawResponseText.length, 'characters');

    // Parse JSON response using repair utility with fallback
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
    
    let markingSchemeData;
    try {
      markingSchemeData = parseJSONWithRepair(rawResponseText);
    } catch (parseError) {
      console.error('   ❌ Failed to parse JSON:', parseError.message);
      // Save with parse_failed status to both collections
      await saveMarkingSchemeToMongoDB({
        payload,
        rawResponse: rawResponseText,
        status: 'parse_failed',
        tenantId: payload.tenantId,
        createdBy: payload.createdBy
      });
      
      // Save to QuestionPaper collection even when parsing fails
      await saveQuestionPaperToMongoDB({
        payload,
        questionPaperData: null, // No parsed data available
        rawResponse: rawResponseText,
        status: 'parse_failed',
        tenantId: payload.tenantId,
        createdBy: payload.createdBy
      });
      
      return res.status(200).json({
        success: true,
        message: 'Marking scheme extraction completed but parsing failed. Raw response saved.',
        status: 'parse_failed'
      });
    }

    // Save to MongoDB - MarkingScheme collection
    await saveMarkingSchemeToMongoDB({
      payload,
      markingScheme: markingSchemeData,
      rawResponse: rawResponseText,
      status: 'draft',
      tenantId: payload.tenantId,
      createdBy: payload.createdBy,
      tokenUsage: calculateTokenCost(result.response.usageMetadata || {})
    });

    // Save to QuestionPaper collection
    await saveQuestionPaperToMongoDB({
      payload,
      questionPaperData: markingSchemeData,
      rawResponse: rawResponseText,
      status: 'draft',
      tenantId: payload.tenantId,
      createdBy: payload.createdBy
    });

    console.log('✅ Marking scheme extraction completed successfully');
    res.status(200).json({
      success: true,
      message: 'Marking scheme extracted successfully',
      status: 'draft'
    });

  } catch (error) {
    console.error('❌ Error in processMarkingSchemeExtraction:', error);
    res.status(200).json({ success: false, message: error.message });
  }
};

