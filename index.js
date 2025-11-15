/**
 * Google Cloud Function for Processing Evaluation Tasks
 * 
 * This function is triggered by Cloud Tasks (Slapp queue)
 * - Receives complete evaluation payload
 * - Sends to Vertex AI (Gemini) for processing
 * - Queues response in SlappResponses queue
 */

const { VertexAI } = require('@google-cloud/vertexai');
const { CloudTasksClient } = require('@google-cloud/tasks');

// ============================================================================
// VERTEX AI DATA SOURCE CONFIGURATION
// ============================================================================
// Configure your Vertex AI data source (retrieval) here.
// Copy and paste your data source ID below.
// ============================================================================

const VERTEX_AI_DATA_SOURCE_ID = 'ajas-cbse-10th-teacher-datastore_1763198188199';

// Initialize Vertex AI - it will automatically use Application Default Credentials
// from the Cloud Function's service account via the metadata server
const vertexAI = new VertexAI({
  project: process.env.GCP_PROJECT_ID || 'slapp-478005',
  location: 'us-central1'
});

// Initialize Cloud Tasks for response queue
const tasksClient = new CloudTasksClient();

/**
 * Main Cloud Function Entry Point
 * Triggered by Cloud Tasks HTTP request
 */
exports.processEvaluation = async (req, res) => {
  console.log('\n🚀 ============ CLOUD FUNCTION TRIGGERED ============');
  console.log('   Timestamp:', new Date().toISOString());
  console.log('   Project:', process.env.GCP_PROJECT_ID);
  console.log('   Service Account:', process.env.K_SERVICE);
  
  try {
    // Extract payload from Cloud Tasks request
    const payload = req.body;
    
    console.log('📦 Raw payload received:');
    console.log(JSON.stringify(payload, null, 2));
    console.log('\n📋 Payload structure:');
    console.log('   Exam ID:', payload.examId || '❌ MISSING');
    console.log('   Tenant ID:', payload.tenantId || '❌ MISSING');
    console.log('   Students:', payload.students?.length || '❌ MISSING');
    console.log('   Question Paper:', payload.questionPaper?.fileName || '❌ MISSING');
    console.log('   Marking Scheme:', payload.markingScheme ? 'Yes' : 'No');
    console.log('   Exam Metadata:', payload.examMetadata ? 'Yes' : 'No');
    console.log('===================================================\n');

    // Validate payload - only require essential fields
    if (!payload.examId) {
      console.error('❌ Validation failed: examId missing');
      throw new Error('Invalid payload: examId is required');
    }
    
    if (!payload.students || !Array.isArray(payload.students) || payload.students.length === 0) {
      console.error('❌ Validation failed: students array missing or empty');
      throw new Error('Invalid payload: students array is required');
    }
    
    if (!payload.questionPaper || !payload.questionPaper.uri) {
      console.error('❌ Validation failed: questionPaper missing or no URI');
      throw new Error('Invalid payload: questionPaper with URI is required');
    }
    
    if (!payload.examMetadata) {
      console.error('❌ Validation failed: examMetadata missing');
      throw new Error('Invalid payload: examMetadata is required');
    }
    
    console.log('✅ Payload validation passed');
    console.log(`   Will process ${payload.students.length} students`);

    // Connect to MongoDB
    await connectToDatabase();

    // Process evaluation with Vertex AI
    const results = await processWithGemini(payload);

    // Save results directly to MongoDB (no second queue needed!)
    console.log('\n💾 ============ SAVING TO MONGODB ============');
    await saveResultsToMongoDB({
      examId: payload.examId,
      tenantId: payload.tenantId,
      evaluationLevel: payload.examMetadata.evaluationLevel,
      results: results,
      createdBy: payload.createdBy
    });
    console.log('✅ Results saved to MongoDB successfully');
    console.log('============================================\n');

    // Respond to Cloud Tasks
    res.status(200).json({
      success: true,
      message: 'Evaluation completed and saved to database',
      examId: payload.examId,
      studentName: payload.student?.studentName,
      studentsProcessed: results.students ? Object.keys(results.students).length : 0
    });

  } catch (error) {
    console.error('❌ Error processing evaluation:', error);
    console.error('   Error stack:', error.stack);
    
    // Save error status to MongoDB
    try {
      await connectToDatabase();
      await handleSaveError({
        examId: req.body.examId,
        tenantId: req.body.tenantId,
        error: error.message
      });
    } catch (dbError) {
      console.error('❌ Failed to update exam status:', dbError);
    }

    res.status(200).json({  // Return 200 to acknowledge task (not 500 which retries)
      success: false,
      message: 'Evaluation failed',
      error: error.message,
      examId: req.body.examId,
      studentName: req.body.student?.studentName
    });
  }
};

/**
 * Retry function with exponential backoff
 */
async function retryWithBackoff(fn, maxRetries = 3, initialDelay = 2000) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const isLastAttempt = attempt === maxRetries;
      const isRetryable = error.status === 503 || error.status === 429 || error.message.includes('overloaded') || error.message.includes('quota');
      
      if (isLastAttempt || !isRetryable) {
        throw error;
      }
      
      const delay = initialDelay * Math.pow(2, attempt - 1);
      console.log(`      ⚠️  Attempt ${attempt} failed: ${error.message}`);
      console.log(`      🔄 Retrying in ${delay/1000}s...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

/**
 * Process single student evaluation with Vertex AI
 */
async function processWithGemini(payload) {
  console.log('\n📤 ============ SENDING TO VERTEX AI ============');
  
  // Since each task contains only 1 student, no batching needed
  const student = payload.students[0];
  console.log(`   Processing student: ${student.studentName} (Roll: ${student.rollNumber})`);

  try {
    // Generate report card with retry logic
    console.log(`   📤 Calling Vertex AI...`);
    const result = await retryWithBackoff(() => 
      generateStudentReportCard(
        student,
        payload.examMetadata.subjectName,
        payload.examMetadata.className,
        payload.examMetadata.examTypeName,
        payload.examMetadata.evaluationLevel,
        payload.markingScheme
      )
    );

    console.log(`   ✅ Evaluation complete`);
    console.log(`   💰 Cost: $${(result.tokenUsage.totalCost || 0).toFixed(6)}`);
    console.log(`   🎯 Student evaluated: ${student.studentName}`);
    console.log('============================================\n');

    return {
      students: result.students,
      tokenUsage: result.tokenUsage
    };
  } catch (error) {
    console.error(`   ❌ Evaluation failed:`, error.message);
    throw error;
  }
}

/**
 * Generate report card for a single student using Vertex AI
 */
async function generateStudentReportCard(
  student,
  subjectName,
  className,
  examTypeName,
  evaluationLevel,
  markingScheme
) {
  // Get Gemini 2.5 Flash model from Vertex AI with data source (retrieval) configuration
  const projectId = process.env.GCP_PROJECT_ID || 'slapp-478005';
  // Location can be 'global', 'us-central1', 'europe-west1', etc. depending on where your datastore is
  // For Vertex AI Search datastores, 'global' is commonly used
  const location = 'global';
  
  // Configure data source for grounding/retrieval
  // Format: projects/{project}/locations/{location}/collections/{collection}/dataStores/{datastore}
  // Use default_collection for Vertex AI Search datastores
  const dataStoreName = `projects/${projectId}/locations/${location}/collections/default_collection/dataStores/${VERTEX_AI_DATA_SOURCE_ID}`;
  
  console.log('   🔍 Data Store Resource Name:', dataStoreName);
  
  const generativeModel = vertexAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    // Configure grounding with data store (retrieval)
    tools: [{
      retrieval: {
        vertexAiSearch: {
          datastore: dataStoreName  // Direct string, not nested object
        }
      }
    }]
  });

  // Prepare file parts for Vertex AI - ONLY student answer sheet
  const fileParts = [{
    fileData: {
      fileUri: student.answerSheetUri || student.uri,
      mimeType: student.mimeType || 'application/pdf'
    }
  }];

  // Build optimized prompt for single student
  const prompt = buildEvaluationPrompt(
    [student],  // Pass as array for compatibility
    subjectName,
    className,
    examTypeName,
    evaluationLevel,
    markingScheme
  );

  console.log('   📝 Prompt length:', prompt.length, 'characters');
  console.log('   📎 Files attached:', fileParts.length, '(student answer sheet only)');
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
    // Ensure tools are included in the request (grounding with data store)
    tools: [{
      retrieval: {
        vertexAiSearch: {
          datastore: dataStoreName  // Direct string, not nested object
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

  // Parse JSON response - expecting pure JSON (no markdown)
  let evaluationData;
  
  // Helper function to clean and fix common JSON issues
  function cleanJSON(jsonString) {
    try {
      // Remove markdown code blocks if present
      jsonString = jsonString.replace(/```json\s*\n?/g, '').replace(/```\s*\n?/g, '').trim();
      
      // Remove leading/trailing non-JSON text
      const firstBrace = jsonString.indexOf('{');
      const lastBrace = jsonString.lastIndexOf('}');
      if (firstBrace >= 0 && lastBrace > firstBrace) {
        jsonString = jsonString.substring(firstBrace, lastBrace + 1);
      }
      
      // Fix common JSON issues:
      // 1. Fix unquoted property names (e.g., {studentName: ...} -> {"studentName": ...})
      // Only fix if not already quoted and not inside a string value
      jsonString = jsonString.replace(/([{,]\s*)([a-zA-Z_$][a-zA-Z0-9_$]*)\s*:/g, (match, prefix, propName) => {
        // Check if it's already quoted
        if (!match.includes('"')) {
          return `${prefix}"${propName}":`;
        }
        return match;
      });
      
      // 2. Fix single quotes to double quotes for strings (only clear string delimiters)
      // Match pattern: : 'value' or [ 'value' or , 'value'
      jsonString = jsonString.replace(/([:,\[])\s*'((?:[^'\\]|\\.)*)'(\s*[,}\]])/g, '$1 "$2"$3');
      
      // 3. Fix missing commas between properties (look for } or ] followed by { or [ without comma)
      // This is tricky - we need to be careful not to break strings
      // Use a more sophisticated approach: track string state
      let inString = false;
      let escapeNext = false;
      let result = '';
      
      for (let i = 0; i < jsonString.length; i++) {
        const char = jsonString[i];
        const nextChar = i < jsonString.length - 1 ? jsonString[i + 1] : '';
        const prevChar = i > 0 ? jsonString[i - 1] : '';
        
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
        
        if (!inString) {
          // Check for missing comma: } or ] followed by { or [ or "
          if ((char === '}' || char === ']') && (nextChar === '{' || nextChar === '[' || nextChar === '"')) {
            result += char + ',';
            continue;
          }
          // Check for missing comma: " followed by } or ] (end of string before closing)
          // But we need to check if there's already a comma
          if (prevChar === '"' && (char === '}' || char === ']') && i > 1) {
            const beforeLast = jsonString[i - 2];
            if (beforeLast !== ',' && beforeLast !== ':' && beforeLast !== '[') {
              // Need to check context more carefully - skip for now to avoid false positives
            }
          }
        }
        
        result += char;
      }
      
      jsonString = result;
      
      // 4. Fix trailing commas (safe to do now)
      jsonString = jsonString.replace(/,(\s*[}\]])/g, '$1');
      
      // 5. Fix escaped quotes that might have been double-escaped
      jsonString = jsonString.replace(/\\\\"/g, '\\"');
      
      // 6. Additional pass: Fix missing commas in arrays and objects (character-by-character for safety)
      // This handles cases like: ["item1" "item2"] or {key: "value" key2: "value2"}
      let inString2 = false;
      let escapeNext2 = false;
      let inArray = false;
      let inObject = false;
      let braceDepth = 0;
      let bracketDepth = 0;
      let result2 = '';
      
      for (let i = 0; i < jsonString.length; i++) {
        const char = jsonString[i];
        const nextChar = i < jsonString.length - 1 ? jsonString[i + 1] : '';
        const prevChar = i > 0 ? result2[result2.length - 1] : '';
        const beforePrev = i > 1 ? result2[result2.length - 2] : '';
        
        if (escapeNext2) {
          result2 += char;
          escapeNext2 = false;
          continue;
        }
        
        if (char === '\\') {
          result2 += char;
          escapeNext2 = true;
          continue;
        }
        
        if (char === '"') {
          inString2 = !inString2;
          result2 += char;
          continue;
        }
        
        if (!inString2) {
          if (char === '{') {
            inObject = true;
            braceDepth++;
            result2 += char;
            continue;
          }
          if (char === '}') {
            braceDepth--;
            if (braceDepth === 0) inObject = false;
            result2 += char;
            continue;
          }
          if (char === '[') {
            inArray = true;
            bracketDepth++;
            result2 += char;
            continue;
          }
          if (char === ']') {
            bracketDepth--;
            if (bracketDepth === 0) inArray = false;
            result2 += char;
            continue;
          }
          
          // Fix missing comma: closing quote followed by opening quote (array elements)
          if (prevChar === '"' && char === '"' && inArray && beforePrev !== ',' && beforePrev !== '[') {
            result2 = result2.slice(0, -1) + '",' + char;
            continue;
          }
          
          // Fix missing comma: closing quote followed by { (object in array)
          if (prevChar === '"' && char === '{' && inArray && beforePrev !== ',' && beforePrev !== '[') {
            result2 = result2.slice(0, -1) + '",' + char;
            continue;
          }
          
          // Fix missing comma: } followed by { (objects in array)
          if (prevChar === '}' && char === '{' && inArray && beforePrev !== ',' && beforePrev !== '[') {
            result2 = result2.slice(0, -1) + '},' + char;
            continue;
          }
          
          // Fix missing comma: ] followed by [ (nested arrays)
          if (prevChar === ']' && char === '[' && beforePrev !== ',' && beforePrev !== '[') {
            result2 = result2.slice(0, -1) + '],' + char;
            continue;
          }
          
          // Fix missing comma: } followed by " (property after object value)
          if (prevChar === '}' && char === '"' && inObject && beforePrev !== ',' && beforePrev !== '{') {
            result2 = result2.slice(0, -1) + '},' + char;
            continue;
          }
        }
        
        result2 += char;
      }
      
      jsonString = result2;
      
      // 7. Final cleanup: Remove any duplicate commas that might have been created
      jsonString = jsonString.replace(/,+/g, ',').replace(/,(\s*[}\]])/g, '$1');
      
      return jsonString.trim();
    } catch (e) {
      console.error('   ⚠️ Error cleaning JSON:', e.message);
      return jsonString;
    }
  }
  
  // First, try to parse the entire response as JSON (since we requested pure JSON)
  try {
    const cleanedText = cleanJSON(text);
    evaluationData = JSON.parse(cleanedText);
    console.log('   ✅ Successfully parsed response as pure JSON');
  } catch (directParseError) {
    console.log('   ⚠️ Direct JSON parse failed, trying extraction methods...');
    console.log('   📄 Parse error:', directParseError.message);
    
    // Fallback 1: Try to extract JSON from markdown code blocks (in case Gemini still uses them)
    const jsonCodeBlockMatch = text.match(/```json\s*\n([\s\S]*?)\n```/) || 
                               text.match(/```\s*\n([\s\S]*?)\n```/) ||
                               text.match(/```json\s*\n([\s\S]*?)```/) ||
                               text.match(/```\s*\n([\s\S]*?)```/);
    
    if (jsonCodeBlockMatch) {
      console.log('   ✅ Found JSON in code block');
      try {
        const cleanedJson = cleanJSON(jsonCodeBlockMatch[1]);
        evaluationData = JSON.parse(cleanedJson);
        console.log('   ✅ Successfully parsed JSON from code block');
      } catch (parseError) {
        console.error('   ❌ Failed to parse JSON from code block:', parseError.message);
        const errorPos = parseInt(parseError.message.match(/position (\d+)/)?.[1] || '0');
        console.error('   📄 JSON block content (first 500 chars):', jsonCodeBlockMatch[1].substring(0, 500));
        if (errorPos > 0) {
          console.error('   📄 JSON block content (around error position ' + errorPos + '):', jsonCodeBlockMatch[1].substring(Math.max(0, errorPos - 200), Math.min(jsonCodeBlockMatch[1].length, errorPos + 200)));
        }
        // Continue to next fallback
      }
    }
    
    if (!evaluationData) {
      // Fallback 2: Look for JSON object in the response (starting with { and containing "students")
      const jsonObjPattern = /\{(?:[^{}]|(?:\{(?:[^{}]|(?:[^{}]*))*\}))*"students"(?:[^{}]|(?:\{(?:[^{}]|(?:[^{}]*))*\}))*\}/;
      const jsonObjMatch = text.match(jsonObjPattern) || 
                           text.match(/\{[\s\S]*?"students"[\s\S]*?\}/);
      
      if (jsonObjMatch) {
        console.log('   ✅ Found JSON object in response');
        try {
          const cleanedJson = cleanJSON(jsonObjMatch[0]);
          evaluationData = JSON.parse(cleanedJson);
          console.log('   ✅ Successfully parsed JSON object');
        } catch (parseError) {
          console.error('   ❌ Failed to parse JSON object:', parseError.message);
          console.error('   📄 JSON object preview:', jsonObjMatch[0].substring(0, 500));
          
          // Try to find the JSON object more precisely by looking for the last occurrence of ``` or finding it after markdown
          const sections = text.split(/```/);
          for (let i = sections.length - 1; i >= 0; i--) {
            const section = sections[i].trim();
            if (section.startsWith('{') && section.includes('"students"')) {
              try {
                const cleanedSection = cleanJSON(section);
                evaluationData = JSON.parse(cleanedSection);
                console.log('   ✅ Found and parsed JSON in last code block section');
                break;
              } catch (e) {
                // Continue trying
              }
            }
          }
          
          if (!evaluationData) {
            // Continue to next fallback
          }
        }
      }
    }
    
    if (!evaluationData) {
      // Last resort: Search for JSON by finding "students" key and matching braces
      console.log('   🔍 Last resort: Searching for JSON structure...');
      console.log('   📄 Response length:', text.length, 'characters');
      
      const studentsMatch = text.match(/"students"\s*:/);
      if (studentsMatch) {
        console.log('   ✅ Found "students" key at position:', studentsMatch.index);
        
        // Find opening brace before "students"
        let jsonStart = text.lastIndexOf('{', studentsMatch.index);
        
        // Try to find matching closing brace
        let braceCount = 0;
        let jsonEnd = -1;
        
        for (let i = jsonStart; i < text.length; i++) {
          if (text[i] === '{') braceCount++;
          if (text[i] === '}') {
            braceCount--;
            if (braceCount === 0) {
              jsonEnd = i + 1;
              break;
            }
          }
        }
        
        if (jsonEnd > jsonStart && jsonEnd > 0) {
          try {
            const jsonStr = text.substring(jsonStart, jsonEnd);
            console.log('   📄 Extracted JSON string (first 300 chars):', jsonStr.substring(0, 300));
            const cleanedJson = cleanJSON(jsonStr);
            console.log('   📄 Cleaned JSON string (first 300 chars):', cleanedJson.substring(0, 300));
            evaluationData = JSON.parse(cleanedJson);
            console.log('   ✅ Found and parsed JSON by brace matching');
          } catch (e) {
            console.error('   ❌ Failed to parse JSON by brace matching:', e.message);
            console.error('   📄 Error at position:', e.message.match(/position (\d+)/)?.[1] || 'unknown');
            const errorPos = parseInt(e.message.match(/position (\d+)/)?.[1] || '0');
            if (errorPos > 0) {
              const jsonStr = text.substring(jsonStart, jsonEnd);
              const cleanedJson = cleanJSON(jsonStr);
              console.error('   📄 Content around error:', cleanedJson.substring(Math.max(0, errorPos - 100), Math.min(cleanedJson.length, errorPos + 100)));
            }
            throw new Error(`Could not extract valid JSON from response. Error: ${e.message}. Response preview: ${text.substring(0, 500)}`);
          }
        } else {
          throw new Error(`Could not find complete JSON structure. Response preview: ${text.substring(0, 500)}`);
        }
      } else {
        console.error('   ❌ No "students" key found in response');
        console.error('   📄 Full response text (last 1000 chars):', text.substring(Math.max(0, text.length - 1000)));
        throw new Error(`Response does not contain expected JSON with "students" key. Response preview: ${text.substring(0, 500)}`);
      }
    }
  }

  // Extract token usage from Vertex AI response
  const usageMetadata = response.usageMetadata || {};
  const tokenUsage = calculateTokenCost(usageMetadata);

  // Transform response format to match backend expectations
  // Handle both old format and new CBSE format with detailed feedback
  const studentsData = {};
  const studentResult = evaluationData.students?.[0] || evaluationData.students?.[0];
  
  if (studentResult) {
    // Transform questions to ensure compatibility with backend format
    const transformedQuestions = studentResult.questions?.map(q => {
      // Ensure marksAwarded exists (use awarded_marks if available)
      const marksAwarded = q.marksAwarded !== undefined ? q.marksAwarded : (q.awarded_marks !== undefined ? q.awarded_marks : 0);
      
      // Build comprehensive reason from new format fields
      let reasonForMarksAllocation = q.reasonForMarksAllocation || '';
      
      // Enhance reason with CBSE format details if available
      if (q.why_marks_awarded && q.why_marks_awarded.length > 0) {
        reasonForMarksAllocation = q.why_marks_awarded.join('; ') + (reasonForMarksAllocation ? ' | ' + reasonForMarksAllocation : '');
      }
      
      if (q.deductions && q.deductions.length > 0) {
        const deductionsText = q.deductions.map(d => `${d.reason} (-${d.amount})`).join('; ');
        reasonForMarksAllocation += (reasonForMarksAllocation ? ' | ' : '') + 'Deductions: ' + deductionsText;
      }
      
      // Return transformed question object
      return {
        questionNumber: q.questionNumber,
        section: q.section || 'General',
        questionType: q.questionType || 'SA',
        maxMarks: q.maxMarks || q.out_of || 0,
        marksAwarded: marksAwarded,
        reasonForMarksAllocation: reasonForMarksAllocation || 'Marks awarded based on evaluation criteria',
        // Preserve new format fields for future use
        awarded_marks: q.awarded_marks || marksAwarded,
        out_of: q.out_of || q.maxMarks,
        why_marks_awarded: q.why_marks_awarded,
        deductions: q.deductions,
        tiered_feedback: q.tiered_feedback,
        value_points_matched: q.value_points_matched
      };
    }) || [];
    
    // Transform overallFeedback - keep as object (matching schema)
    let overallFeedbackObj = null;
    if (studentResult.overallFeedback && typeof studentResult.overallFeedback === 'object') {
      // Use the object directly (matching schema structure)
      overallFeedbackObj = {
        summary: studentResult.overallFeedback.summary || '',
        areasOfImprovement: Array.isArray(studentResult.overallFeedback.areasOfImprovement) 
          ? studentResult.overallFeedback.areasOfImprovement 
          : [],
        spellingErrors: Array.isArray(studentResult.overallFeedback.spellingErrors) 
          ? studentResult.overallFeedback.spellingErrors 
          : [],
        recommendations: studentResult.overallFeedback.recommendations || ''
      };
    } else if (typeof studentResult.overallFeedback === 'string') {
      // If it's a string, create an object with the string as summary (backward compatibility)
      overallFeedbackObj = {
        summary: studentResult.overallFeedback,
        areasOfImprovement: [],
        spellingErrors: [],
        recommendations: ''
      };
    } else {
      // Default empty object
      overallFeedbackObj = {
        summary: '',
        areasOfImprovement: [],
        spellingErrors: [],
        recommendations: ''
      };
    }
    
    // Build transformed student result
    studentsData[student.studentId] = {
      studentId: student.studentId,
      studentName: studentResult.studentName || student.studentName,
      rollNumber: studentResult.rollNumber || student.rollNumber,
      questions: transformedQuestions,
      overallRubrics: studentResult.overallRubrics || {
        spellingGrammar: 0,
        creativity: 0,
        clarity: 0,
        depthOfUnderstanding: 0,
        completeness: 0
      },
      overallFeedback: overallFeedbackObj
    };
  }

  return {
    students: studentsData,
    tokenUsage: tokenUsage,
    responseTime: responseTime
  };
}

/**
 * Build optimized evaluation prompt (token-efficient)
 */
function buildEvaluationPrompt(studentAnswers, subjectName, className, examTypeName, evaluationLevel, markingScheme) {
  // Single student (batch size = 1)
  const student = studentAnswers[0];
  
  // Build detailed marking scheme section with value points
  let questionsSection = '';
  if (markingScheme && markingScheme.approved) {
    questionsSection = `## Questions & Marks with Value Points\n\n${markingScheme.sections.map(section => 
      `**${section.sectionName}** (${section.sectionTotalMarks}m)\n${section.questions.map(q => {
        const itemType = q.questionType || 'SA';
        return `Q${q.questionNumber} (${itemType}, ${q.marks}m): ${q.questionText || 'See question paper'}
  - Max Marks (M): ${q.marks}
  - Item Type: ${itemType}
  - Official Value Points: ${q.valuePoints ? q.valuePoints.join(', ') : 'Infer from question content'}
  - Step Marks: ${q.stepMarks ? q.stepMarks.join(' | ') : 'Not specified'}`;
      }).join('\n\n')}`
    ).join('\n\n')}\n\n**Total: ${markingScheme.totalMarks} marks**`;
  } else {
    questionsSection = `## Questions\n\nEvaluate all questions in the answer sheet. Determine appropriate maximum marks for each question. Infer value points and step marks based on question content.`;
  }

  // Get detailed evaluation criteria
  const evalCriteria = getEvaluationInstructions(evaluationLevel);

  return `You are an expert CBSE examiner evaluating a student's answer sheet.

**Subject:** ${subjectName}
**Class:** ${className}
**Exam Type:** ${examTypeName}
**Evaluation Level:** ${evaluationLevel}
**Student:** ${student.studentName} (Roll: ${student.rollNumber})

${questionsSection}

## Evaluation Instructions

${evalCriteria}

## General MCQ Rules (Apply to ALL Evaluation Levels)

**These rules are COMMON for MCQ question type evaluation, regardless of evaluation level (easy, medium, strict, very_strict):**

1. **Option Acceptance:**
   - Accept option letter (A/B/C/D), option text, or both
   - Ignore case (e.g., "a" = "A") and punctuation when matching
   - Match the student's selected option to the correct answer using flexible matching

2. **Multiple Options Selected:**
   - If multiple options are chosen for a single-correct MCQ → award 0 marks
   - If the student has clearly marked/circled/ticked multiple options (even if one is correct) → award 0 marks
   - Only award full marks if exactly ONE option matches the correct answer

3. **Overwritten/Crossed Options:**
   - If the student writes an option and later clearly overwrites/crosses it to select another option, take the FINAL clear intent as the student's choice
   - If the final intent is ambiguous or unclear → award 0 marks
   - Only award marks if there is a clear, unambiguous final selection

4. **Passage/Figure/Data-Based MCQs (Case/Testlet Questions):**
   - For passage-based, figure-based, or data-based MCQs (common in CBSE case/testlet format):
     - The evaluation rationale MUST quote the relevant line number, figure label, or data value from the source
     - Specify which specific part of the passage/figure/data supports the correct answer
     - Example: "Correct answer based on line 3 of the passage: '...quote...'" or "Correct based on label 'X' in Figure 1"
   - This applies even though MCQ questions don't require detailed feedback - the rationale should still reference the source

**MCQ Scoring Summary (Same for ALL Evaluation Levels):**
- Correct option selected (single, clear selection) → Full marks (maxMarks)
- Wrong option selected OR multiple options selected OR ambiguous selection → 0 marks
- Binary evaluation: All or nothing (no partial credit)
- These rules apply uniformly whether evaluation level is easy, medium, strict, or very_strict

## Output Format

**CRITICAL: Return ONLY valid JSON. Do NOT include any markdown, text explanations, or code block markers. Return pure JSON only.**

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
            {"amount": 1, "reason": "Missing final step"},
            {"amount": 1, "reason": "Minor grammar issue"}
          ],
          "tiered_feedback": {
            "below_average": "<1 fix now action in plain language>",
            "average": "<1 refinement to reach full marks>",
            "above_average": "<1 enrichment or precision tip>",
            "brilliant": "<1 extension/insight to deepen mastery>"
          },
          "value_points_matched": ["<point 1>", "<point 2>", "..."],
          "reasonForMarksAllocation": "Brief summary of marks awarded"
        }
      ],
      "overallRubrics": {
        "spellingGrammar": 8,
        "creativity": 7,
        "clarity": 9,
        "depthOfUnderstanding": 8,
        "completeness": 8
      },
      "overallFeedback": {
        "summary": "Overall performance summary (100-150 words)",
        "areasOfImprovement": ["Area 1", "Area 2"],
        "spellingErrors": ["word1", "word2"],
        "recommendations": "Specific recommendations"
      }
    }
  ]
}

**Critical Requirements:**
- Return ONLY valid JSON - no markdown, no code blocks, no text explanations
- Start your response with { and end with }
- **For MCQ questions:**
  - Follow the General MCQ Rules section above (option acceptance, multiple options, overwritten options, passage/figure-based requirements)
  - Set marksAwarded to maxMarks (if correct) or 0 (if wrong). Binary evaluation only.
  - Skip why_marks_awarded, deductions, tiered_feedback fields for MCQs (they are not required).
  - For passage/figure/data-based MCQs: Still include a brief reasonForMarksAllocation that quotes the relevant line/label/value from the source.
- **For Non-MCQ questions:**
  - Provide all fields including why_marks_awarded, deductions, tiered_feedback, value_points_matched.
  - Follow the evaluation level-specific instructions above.
- Use exact max marks from marking scheme.
- Round final marks to nearest 0.5 for consistency.
- Be brief, point-wise, and never invent facts not shown in the answer.
- Ensure the JSON is valid and parseable.`;
}

/**
 * Get evaluation instructions based on level
 */
function getEvaluationInstructions(level) {
  const instructions = {
    'easy': `*Role*: You are a CBSE examiner. Award marks using step‑marking and value points. Prefer inclusion over exclusion: if a response is close to correct, give credit and explain why.

*Easy‑level rules (short):*

1. *Step marking & value points.* Award for each correct/partially correct point shown. If steps are mostly correct but the last line slips, still award *60–80%* of M.

2. *Accept alternatives.* Give credit for equivalent wording, examples, or methods.

3. *No repeat penalties.* Don't deduct more than once for the same recurring mistake.

4. *Gentle presentation/grammar.* Minor grammar, spelling, unit, or neatness issues: at most *min(2, 0.1×M)* total deduction for the whole answer.

5. *Objective items (MCQ/Fill/True‑False).* Full M if correct, else 0. No strictness scaling.

6. *Writing tasks (letters/articles/notices).* Split marks simply: *Format 20% | Content/Ideas 70% | Language 10%*. If format elements are present in any reasonable form, award them.

7. *Math/Numericals/Derivations.* Credit each valid step; missing unit or rough figure = *0.05×M* deduction (cap *0.1×M*).

8. *Map/Label/Diagram.* Award per correct label; small penalty only for missing labels; do not over‑penalize drawing quality.

9. *Benefit of doubt.* If evidence is borderline or OCR is unclear, prefer awarding the lower of two possible credits rather than deducting.

*Scoring recipe (keep it proportional & simple):*

* If item_type = MCQ: score = M or 0.

* Else start with base = 0.
  * *Content/Value points (≈70% of M):* base += 0.7M × (matched_value_points / expected_value_points).
  * *Method/Steps/Reasoning (≈20% of M):* add up to 0.2M depending on clarity of working/structure.
  * *Format/Presentation (≈10% of M):* add up to 0.1M for format/labels/organisation (Writing/Map/Diagram).
  * Apply *small deductions* per rule 4 & 7 with the stated caps.
  * *Clamp* final score to [0, M] and *round to nearest 0.5* for consistency.`,

    'medium': 'Award marks fairly based on correctness. Consider partial understanding.',
    'standard': 'Award marks fairly based on correctness. Consider partial understanding.',
    'strict': 'Evaluate with high standards. Require complete and accurate answers.',
    'very_strict': 'Apply maximum rigor. Expect excellence. No marks for incomplete answers.'
  };

  return instructions[level] || instructions['medium'];
}

/**
 * Calculate token cost
 */
function calculateTokenCost(usageMetadata) {
  const promptTokens = usageMetadata.promptTokenCount || 0;
  const outputTokens = usageMetadata.candidatesTokenCount || 0;
  const totalTokens = usageMetadata.totalTokenCount || promptTokens + outputTokens;

  // Gemini 2.5 Flash pricing via Vertex AI
  const INPUT_COST_PER_1M = 0.075;   // $0.075 per 1M input tokens
  const OUTPUT_COST_PER_1M = 0.30;   // $0.30 per 1M output tokens

  const inputCost = (promptTokens / 1000000) * INPUT_COST_PER_1M;
  const outputCost = (outputTokens / 1000000) * OUTPUT_COST_PER_1M;
  const totalCost = inputCost + outputCost;

  return {
    promptTokens,
    outputTokens,
    totalTokens,
    inputCost,
    outputCost,
    totalCost
  };
}

/**
 * ============================================================
 * MONGODB CONNECTION AND MODELS
 * ============================================================
 */

const mongoose = require('mongoose');

// MongoDB connection cache
let cachedDb = null;

async function connectToDatabase() {
  if (cachedDb && mongoose.connection.readyState === 1) {
    console.log('   ✅ Using cached database connection');
    return cachedDb;
  }

  console.log('   🔌 Connecting to MongoDB...');
  
  const MONGODB_URI = process.env.MONGODB_URI;
  if (!MONGODB_URI) {
    throw new Error('MONGODB_URI environment variable is not set');
  }

  await mongoose.connect(MONGODB_URI, {
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
  });

  cachedDb = mongoose.connection;
  console.log('   ✅ Connected to MongoDB:', mongoose.connection.name);
  
  return cachedDb;
}

// Mongoose schemas (same as backend)
const evaluationSchema = new mongoose.Schema({
  examId: mongoose.Schema.Types.ObjectId,
  studentId: mongoose.Schema.Types.ObjectId,
  studentName: String,
  rollNumber: String,
  className: String,
  section: String,
  subjectName: String,
  examTypeName: String,
  evaluationLevel: String,
  questions: [{
    questionNumber: String,
    section: String,
    questionType: String,
    maxMarks: Number,
    marksAwarded: Number,
    reasonForMarksAllocation: String,
    // New CBSE format fields
    awarded_marks: Number,
    out_of: Number,
    why_marks_awarded: [String],
    deductions: [{
      amount: Number,
      reason: String
    }],
    tiered_feedback: {
      below_average: String,
      average: String,
      above_average: String,
      brilliant: String
    },
    value_points_matched: [String],
    rubrics: {
      spellingGrammar: Number,
      creativity: Number,
      clarity: Number,
      depthOfUnderstanding: Number,
      completeness: Number
    }
  }],
  overallFeedback: {
    summary: String,
    areasOfImprovement: [String],
    spellingErrors: [String],
    recommendations: String,
    translations: {
      summary_en: String,
      areasOfImprovement_en: [String],
      recommendations_en: String
    }
  },
  totalMarksAwarded: Number,
  totalMaxMarks: Number,
  percentage: Number,
  aggregateRubrics: {
    averageSpellingGrammar: Number,
    averageCreativity: Number,
    averageClarity: Number,
    averageDepthOfUnderstanding: Number,
    averageCompleteness: Number,
    overallAverageRubricScore: Number
  },
  status: { type: String, default: 'completed' },
  evaluatedAt: Date,
  tenantId: String,
  createdBy: String,
  updatedBy: String,
  softDelete: { type: Boolean, default: false }
}, { timestamps: true });

const examResultSchema = new mongoose.Schema({
  examId: mongoose.Schema.Types.ObjectId,
  studentId: mongoose.Schema.Types.ObjectId,
  studentName: String,
  rollNumber: String,
  className: String,
  section: String,
  subjectId: mongoose.Schema.Types.ObjectId,
  subjectName: String,
  examTypeId: mongoose.Schema.Types.ObjectId,
  examTypeName: String,
  examDate: Date,
  evaluationLevel: String,
  marksObtained: Number,
  totalMarks: Number,
  percentage: Number,
  grade: String,
  status: String,
  tenantId: String,
  createdBy: String,
  updatedBy: String,
  softDelete: { type: Boolean, default: false }
}, { timestamps: true });

const examSchema = new mongoose.Schema({
  examTitle: String,
  className: String,
  section: String,
  subjectName: String,
  examTypeName: String,
  subjectId: mongoose.Schema.Types.ObjectId,
  examTypeId: mongoose.Schema.Types.ObjectId,
  markingSchemeId: mongoose.Schema.Types.ObjectId,
  studentAnswerSheets: [{
    studentId: mongoose.Schema.Types.ObjectId,
    studentName: String,
    rollNumber: String,
    answerSheetUri: String,
    pageCount: Number
  }],
  status: String,
  tokenUsage: {
    promptTokens: Number,
    outputTokens: Number,
    totalTokens: Number,
    inputCost: Number,
    outputCost: Number,
    totalCost: Number
  },
  evaluatedLevels: [{
    level: String,
    evaluatedAt: Date,
    tokenUsage: {
      promptTokens: Number,
      outputTokens: Number,
      totalTokens: Number,
      inputCost: Number,
      outputCost: Number,
      totalCost: Number
    }
  }],
  tenantId: String,
  updatedBy: String,
  softDelete: Boolean
}, { timestamps: true });

const examTypeSchema = new mongoose.Schema({
  passMarks: Number,
  maximumMarks: Number,
  tenantId: String,
  softDelete: Boolean
}, { timestamps: true });

const markingSchemeSchema = new mongoose.Schema({
  sections: [{
    sectionName: String,
    questions: [{
      questionNumber: String,
      marks: Number,
      description: String
    }]
  }],
  approved: Boolean
}, { timestamps: true });

// Mongoose models
const Evaluation = mongoose.models.Evaluation || mongoose.model('Evaluation', evaluationSchema);
const ExamResult = mongoose.models.ExamResult || mongoose.model('ExamResult', examResultSchema);
const Exam = mongoose.models.Exam || mongoose.model('Exam', examSchema);
const ExamType = mongoose.models.ExamType || mongoose.model('ExamType', examTypeSchema);
const MarkingScheme = mongoose.models.MarkingScheme || mongoose.model('MarkingScheme', markingSchemeSchema);

/**
 * ============================================================
 * MONGODB SAVE FUNCTIONS (Called directly from processEvaluation)
 * ============================================================
 */

async function saveResultsToMongoDB(responseData) {
  const { examId, tenantId, evaluationLevel, results, createdBy } = responseData;
  
  // Define createdByValue early to use throughout the function
  const createdByValue = createdBy || 'cloud-function';

  const exam = await Exam.findOne({ _id: examId, tenantId, softDelete: false });
  if (!exam) throw new Error('Exam not found');

  // Build max marks mapping and section mapping from approved marking scheme
  let maxMarksMap = {};
  let sectionMap = {}; // Map questionNumber to sectionName
  let schemeTotalMarks = null;
  
  if (exam.markingSchemeId) {
    const markingScheme = await MarkingScheme.findById(exam.markingSchemeId);
    if (markingScheme?.approved) {
      schemeTotalMarks = markingScheme.totalMarks;  // Store the official total
      markingScheme.sections.forEach(section => {
        section.questions?.forEach(q => {
          maxMarksMap[q.questionNumber] = q.marks;
          sectionMap[q.questionNumber] = section.sectionName; // Map question to section
        });
      });
      console.log(`   📋 Using marking scheme total marks: ${schemeTotalMarks}`);
      console.log(`   📋 Section mapping created for ${Object.keys(sectionMap).length} questions`);
    }
  }

  const studentsWithAnswers = exam.studentAnswerSheets.filter(s => s.answerSheetUri);
  let successCount = 0;

  for (const studentSheet of studentsWithAnswers) {
    const studentId = studentSheet.studentId.toString();
    const evaluationResult = results.students[studentId];

    if (!evaluationResult?.questions) continue;

    // ALWAYS use marking scheme max marks and section (override AI's values completely)
    const questionsWithCorrectMaxMarks = evaluationResult.questions.map(q => {
      const correctedQuestion = {
        ...q,
        maxMarks: maxMarksMap[q.questionNumber] || q.maxMarks
      };
      
      // Populate section from marking scheme if available (prioritize marking scheme section)
      if (sectionMap[q.questionNumber]) {
        correctedQuestion.section = sectionMap[q.questionNumber];
      } else if (!correctedQuestion.section || correctedQuestion.section === 'General' || correctedQuestion.section === 'N/A') {
        // Keep existing section or use default if no section in marking scheme
        correctedQuestion.section = correctedQuestion.section || 'General';
      }
      
      return correctedQuestion;
    });

    const totalMarksAwarded = questionsWithCorrectMaxMarks.reduce((sum, q) => sum + (parseFloat(q.marksAwarded) || 0), 0);
    
    // Use marking scheme total if available, otherwise calculate from questions
    const totalMaxMarks = schemeTotalMarks || questionsWithCorrectMaxMarks.reduce((sum, q) => sum + (parseFloat(q.maxMarks) || 0), 0);
    
    const percentage = totalMaxMarks > 0 ? (totalMarksAwarded / totalMaxMarks) * 100 : 0;
    
    console.log(`   📊 ${studentSheet.studentName}: ${totalMarksAwarded}/${totalMaxMarks} (${percentage.toFixed(2)}%)`);
    console.log(`      Source: ${schemeTotalMarks ? 'Marking Scheme' : 'Calculated from AI response'}`);

    const aggregateRubrics = {
      averageSpellingGrammar: evaluationResult.overallRubrics?.spellingGrammar || 0,
      averageCreativity: evaluationResult.overallRubrics?.creativity || 0,
      averageClarity: evaluationResult.overallRubrics?.clarity || 0,
      averageDepthOfUnderstanding: evaluationResult.overallRubrics?.depthOfUnderstanding || 0,
      averageCompleteness: evaluationResult.overallRubrics?.completeness || 0,
      overallAverageRubricScore: 0
    };

    const totalRubricScore = Object.values(aggregateRubrics).slice(0, 5).reduce((a, b) => a + b, 0);
    aggregateRubrics.overallAverageRubricScore = parseFloat((totalRubricScore / 5).toFixed(2));

    const percentageValue = parseFloat(percentage.toFixed(2));
    let grade = 'F';
    if (percentageValue >= 90) grade = 'A+';
    else if (percentageValue >= 80) grade = 'A';
    else if (percentageValue >= 70) grade = 'B+';
    else if (percentageValue >= 60) grade = 'B';
    else if (percentageValue >= 50) grade = 'C';
    else if (percentageValue >= 40) grade = 'D';

    const examType = await ExamType.findOne({ _id: exam.examTypeId, tenantId, softDelete: false });
    const passPercentage = examType ? (examType.passMarks / examType.maximumMarks) * 100 : 40;
    const status = percentageValue >= passPercentage ? 'pass' : 'fail';

    await new Evaluation({
      examId, studentId: studentSheet.studentId, studentName: studentSheet.studentName,
      rollNumber: studentSheet.rollNumber, className: exam.className, section: exam.section,
      subjectName: exam.subjectName, examTypeName: exam.examTypeName, evaluationLevel,
      questions: questionsWithCorrectMaxMarks, overallFeedback: evaluationResult.overallFeedback,
      totalMarksAwarded, totalMaxMarks, percentage: percentageValue, aggregateRubrics,
      status: 'completed', evaluatedAt: new Date(), tenantId, createdBy: createdByValue, updatedBy: createdByValue
    }).save();

    await new ExamResult({
      examId, studentId: studentSheet.studentId, studentName: studentSheet.studentName,
      rollNumber: studentSheet.rollNumber, className: exam.className, section: exam.section,
      subjectId: exam.subjectId, subjectName: exam.subjectName, examTypeId: exam.examTypeId,
      examTypeName: exam.examTypeName, examDate: exam.examDate, evaluationLevel,
      marksObtained: totalMarksAwarded, totalMarks: totalMaxMarks, percentage: percentageValue,
      grade, status, tenantId, createdBy: createdByValue, updatedBy: createdByValue
    }).save();

    successCount++;
    console.log(`   ✅ ${studentSheet.studentName}: ${totalMarksAwarded}/${totalMaxMarks} (${percentageValue}%)`);
  }

  exam.status = 'evaluated';
  if (results.tokenUsage) {
    exam.tokenUsage = results.tokenUsage;
    if (!exam.evaluatedLevels) exam.evaluatedLevels = [];
    const levelIndex = exam.evaluatedLevels.findIndex(el => el.level === evaluationLevel);
    if (levelIndex >= 0) {
      exam.evaluatedLevels[levelIndex] = { level: evaluationLevel, evaluatedAt: new Date(), tokenUsage: results.tokenUsage };
    } else {
      exam.evaluatedLevels.push({ level: evaluationLevel, evaluatedAt: new Date(), tokenUsage: results.tokenUsage });
    }
  }
  exam.updatedBy = createdByValue;
  await exam.save();

  console.log(`   📊 Summary: ${successCount} students saved`);
}

async function handleSaveError(errorData) {
  try {
    const exam = await Exam.findOne({ _id: errorData.examId, tenantId: errorData.tenantId, softDelete: false });
    if (exam) {
      exam.status = 'created';  // Reset to created status on error
      exam.updatedBy = 'cloud-function';
      await exam.save();
      console.log(`   ✅ Exam status reset to 'created' due to error`);
    }
  } catch (error) {
    console.error('   ❌ Error handling save error:', error);
  }
}

