/**
 * Google Cloud Function for Processing Evaluation Tasks
 * 
 * This function is triggered by Cloud Tasks (Slapp queue)
 * - Receives complete evaluation payload
 * - Sends to Gemini for processing
 * - Queues response in SlappResponses queue
 */

const { GoogleGenerativeAI } = require('@google/generative-ai');
const { GoogleAIFileManager } = require('@google/generative-ai/server');
const { CloudTasksClient } = require('@google-cloud/tasks');

// Initialize Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const fileManager = new GoogleAIFileManager(process.env.GEMINI_API_KEY);

// Initialize Cloud Tasks for response queue
const tasksClient = new CloudTasksClient();

/**
 * Main Cloud Function Entry Point
 * Triggered by Cloud Tasks HTTP request
 */
exports.processEvaluation = async (req, res) => {
  console.log('\n🚀 ============ CLOUD FUNCTION TRIGGERED ============');
  console.log('   Timestamp:', new Date().toISOString());
  
  try {
    // Extract payload from Cloud Tasks request
    const payload = req.body;
    
    console.log('📦 Payload received:');
    console.log('   Exam ID:', payload.examId);
    console.log('   Students:', payload.students?.length || 0);
    console.log('   Question Paper:', payload.questionPaper?.fileName);
    console.log('   Marking Scheme:', payload.markingScheme ? 'Yes' : 'No');
    console.log('===================================================\n');

    // Validate payload
    if (!payload.examId || !payload.students || !payload.questionPaper) {
      throw new Error('Invalid payload: missing required fields');
    }

    // Process evaluation with Gemini
    const results = await processWithGemini(payload);

    // Queue response in SlappResponses queue
    await queueResponse({
      examId: payload.examId,
      tenantId: payload.tenantId,
      evaluationLevel: payload.examMetadata.evaluationLevel,
      results: results,
      processedAt: new Date().toISOString(),
      status: 'success'
    });

    // Respond to Cloud Tasks
    res.status(200).json({
      success: true,
      message: 'Evaluation completed and queued in response queue',
      examId: payload.examId,
      studentsProcessed: results.students ? Object.keys(results.students).length : 0
    });

  } catch (error) {
    console.error('❌ Error processing evaluation:', error);
    
    // Queue error response
    try {
      await queueResponse({
        examId: req.body.examId,
        tenantId: req.body.tenantId,
        status: 'error',
        error: error.message,
        processedAt: new Date().toISOString()
      });
    } catch (queueError) {
      console.error('❌ Failed to queue error response:', queueError);
    }

    res.status(500).json({
      success: false,
      message: 'Evaluation failed',
      error: error.message
    });
  }
};

/**
 * Process evaluation with Gemini
 */
async function processWithGemini(payload) {
  console.log('\n📤 ============ SENDING TO GEMINI ============');
  
  const BATCH_SIZE = 2;
  const totalStudents = payload.students.length;
  const allStudentsData = {};
  let aggregatedTokenUsage = {
    promptTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    inputCost: 0,
    outputCost: 0,
    totalCost: 0
  };

  console.log(`   Processing ${totalStudents} students in batches of ${BATCH_SIZE}`);

  // Process students in batches
  for (let i = 0; i < totalStudents; i += BATCH_SIZE) {
    const batchNumber = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(totalStudents / BATCH_SIZE);
    const studentBatch = payload.students.slice(i, i + BATCH_SIZE);
    
    console.log(`\n   📊 Batch ${batchNumber}/${totalBatches}:`);
    console.log(`      Students: ${studentBatch.map(s => s.studentName).join(', ')}`);

    try {
      // Generate batch report cards
      const batchResults = await generateBatchReportCards(
        payload.questionPaper,
        studentBatch,
        payload.examMetadata.subjectName,
        payload.examMetadata.className,
        payload.examMetadata.examTypeName,
        payload.examMetadata.evaluationLevel,
        payload.referenceDocuments || [],
        payload.markingScheme
      );

      // Aggregate results
      const batchStudentsData = batchResults.students || {};
      const batchTokenUsage = batchResults.tokenUsage || {};

      Object.assign(allStudentsData, batchStudentsData);
      
      aggregatedTokenUsage.promptTokens += batchTokenUsage.promptTokens || 0;
      aggregatedTokenUsage.outputTokens += batchTokenUsage.outputTokens || 0;
      aggregatedTokenUsage.totalTokens += batchTokenUsage.totalTokens || 0;
      aggregatedTokenUsage.inputCost += batchTokenUsage.inputCost || 0;
      aggregatedTokenUsage.outputCost += batchTokenUsage.outputCost || 0;
      aggregatedTokenUsage.totalCost += batchTokenUsage.totalCost || 0;

      console.log(`      ✅ Batch complete - Cost: $${(batchTokenUsage.totalCost || 0).toFixed(6)}`);
      
      // Delay between batches
      if (i + BATCH_SIZE < totalStudents) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    } catch (error) {
      console.error(`      ❌ Batch ${batchNumber} failed:`, error.message);
      throw error;
    }
  }

  console.log('\n   ✅ All batches completed');
  console.log(`   💰 Total cost: $${aggregatedTokenUsage.totalCost.toFixed(6)}`);
  console.log(`   🎯 Students evaluated: ${Object.keys(allStudentsData).length}/${totalStudents}`);
  console.log('============================================\n');

  return {
    students: allStudentsData,
    tokenUsage: aggregatedTokenUsage
  };
}

/**
 * Generate batch report cards using Gemini
 */
async function generateBatchReportCards(
  questionPaper,
  studentAnswers,
  subjectName,
  className,
  examTypeName,
  evaluationLevel,
  referenceDocuments,
  markingScheme
) {
  const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

  // Prepare file parts for Gemini
  const fileParts = [];

  // Add question paper
  fileParts.push({
    fileData: {
      fileUri: questionPaper.uri,
      mimeType: questionPaper.mimeType
    }
  });

  // Add reference documents
  if (referenceDocuments && referenceDocuments.length > 0) {
    referenceDocuments.forEach(doc => {
      fileParts.push({
        fileData: {
          fileUri: doc.uri,
          mimeType: doc.mimeType
        }
      });
    });
  }

  // Add student answer sheets
  studentAnswers.forEach(student => {
    fileParts.push({
      fileData: {
        fileUri: student.answerSheetUri || student.uri,
        mimeType: student.mimeType
      }
    });
  });

  // Build prompt
  const prompt = buildEvaluationPrompt(
    studentAnswers,
    subjectName,
    className,
    examTypeName,
    evaluationLevel,
    markingScheme
  );

  console.log('      📝 Prompt length:', prompt.length, 'characters');
  console.log('      📎 Files attached:', fileParts.length);

  // Call Gemini
  const startTime = Date.now();
  const result = await model.generateContent([prompt, ...fileParts]);
  const responseTime = Date.now() - startTime;

  console.log('      ⏱️  Response time:', responseTime, 'ms');

  const response = result.response;
  const text = response.text();

  // Parse JSON response
  const jsonMatch = text.match(/```json\n([\s\S]*?)\n```/) || text.match(/```\n([\s\S]*?)\n```/);
  let evaluationData;
  
  if (jsonMatch) {
    evaluationData = JSON.parse(jsonMatch[1]);
  } else {
    evaluationData = JSON.parse(text);
  }

  // Extract token usage
  const usageMetadata = response.usageMetadata || {};
  const tokenUsage = calculateTokenCost(usageMetadata);

  // Organize results by student
  const studentsData = {};
  studentAnswers.forEach(student => {
    const studentResult = evaluationData.students?.find(s => 
      s.studentName === student.studentName || 
      s.rollNumber === student.rollNumber
    );
    
    if (studentResult) {
      studentsData[student.studentId] = studentResult;
    }
  });

  return {
    students: studentsData,
    tokenUsage: tokenUsage,
    responseTime: responseTime
  };
}

/**
 * Build evaluation prompt for Gemini
 */
function buildEvaluationPrompt(studentAnswers, subjectName, className, examTypeName, evaluationLevel, markingScheme) {
  const studentList = studentAnswers.map((s, i) => 
    `${i + 1}. ${s.studentName} (Roll: ${s.rollNumber})`
  ).join('\n');

  let markingSchemeSection = '';
  if (markingScheme && markingScheme.approved) {
    markingSchemeSection = `

## 📋 MARKING SCHEME (USE THESE EXACT MARKS)

**Total Marks: ${markingScheme.totalMarks}**

${markingScheme.sections.map(section => `
### ${section.sectionName}
${section.questions.map(q => 
  `- **Question ${q.questionNumber}**: ${q.marks} marks${q.description ? ` - ${q.description}` : ''}`
).join('\n')}
`).join('\n')}

⚠️ **IMPORTANT**: Use the EXACT maximum marks from the marking scheme above. Do NOT estimate or guess marks.
`;
  }

  const evaluationInstructions = getEvaluationInstructions(evaluationLevel);

  return `You are an expert ${subjectName} teacher evaluating ${className} students' ${examTypeName} exam answer sheets.

## 📚 DOCUMENTS PROVIDED

1. **Question Paper** (First document)
2. **Reference Documents** (If any)
3. **Student Answer Sheets** (One for each student below)

## 👥 STUDENTS TO EVALUATE

${studentList}

${markingSchemeSection}

## 📊 EVALUATION CRITERIA

${evaluationInstructions}

## 📝 RESPONSE FORMAT

Return a JSON object in this EXACT format:

\`\`\`json
{
  "students": [
    {
      "studentName": "Student Name",
      "rollNumber": "Roll Number",
      "questions": [
        {
          "questionNumber": "1",
          "questionType": "MCQ/Short Answer/Essay/etc",
          "maxMarks": 5,
          "marksAwarded": 4,
          "reasonForMarksAllocation": "Detailed reason",
          "rubrics": {
            "spellingGrammar": 8,
            "creativity": 7,
            "clarity": 9,
            "depthOfUnderstanding": 8,
            "completeness": 7
          }
        }
      ],
      "overallRubrics": {
        "spellingGrammar": 8,
        "creativity": 7,
        "clarity": 9,
        "depthOfUnderstanding": 8,
        "completeness": 7
      },
      "overallFeedback": "Comprehensive feedback for the student"
    }
  ]
}
\`\`\`

## ⚠️ CRITICAL REQUIREMENTS

1. **Use EXACT marks from marking scheme** (if provided)
2. **Evaluate ALL students** listed above
3. **Return ONLY valid JSON** (no extra text)
4. **Include all rubric scores** (0-10 scale)
5. **Provide detailed feedback** for each question
6. **Overall rubrics** should be averaged across all questions

Analyze the documents and return the evaluation results now.`;
}

/**
 * Get evaluation instructions based on level
 */
function getEvaluationInstructions(level) {
  const instructions = {
    'lenient': `
- Be generous with partial marks
- Focus on effort and attempt
- Encourage student learning
- Award marks for any correct elements`,
    
    'standard': `
- Follow standard evaluation practices
- Award marks fairly based on correctness
- Consider partial understanding
- Balance strictness with fairness`,
    
    'strict': `
- Evaluate with high standards
- Require complete and accurate answers
- Minimal partial marks
- Focus on precision and completeness`,
    
    'very_strict': `
- Apply maximum rigor
- Expect excellence in every aspect
- No marks for incomplete answers
- Demand perfect accuracy and presentation`
  };

  return instructions[level] || instructions['standard'];
}

/**
 * Calculate token cost
 */
function calculateTokenCost(usageMetadata) {
  const promptTokens = usageMetadata.promptTokenCount || 0;
  const outputTokens = usageMetadata.candidatesTokenCount || 0;
  const totalTokens = usageMetadata.totalTokenCount || promptTokens + outputTokens;

  // Gemini 1.5 Flash pricing (as of 2024)
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
 * Queue response in SlappResponses queue
 */
async function queueResponse(responseData) {
  console.log('\n📨 ============ QUEUING RESPONSE ============');
  
  try {
    const project = process.env.GCP_PROJECT_ID;
    const location = process.env.GCP_LOCATION || 'asia-south1';
    const queue = process.env.GCP_TASK_RESPONSES_QUEUE || 'SlappResponses';
    const serviceUrl = process.env.BACKEND_SERVICE_URL;

    const parent = tasksClient.queuePath(project, location, queue);
    const url = `${serviceUrl}/api/tasks/process-response`;

    console.log('   Queue:', queue);
    console.log('   Target URL:', url);
    console.log('   Exam ID:', responseData.examId);

    const task = {
      httpRequest: {
        httpMethod: 'POST',
        url: url,
        headers: {
          'Content-Type': 'application/json',
        },
        body: Buffer.from(JSON.stringify(responseData)).toString('base64'),
      },
    };

    const request = { parent, task };
    const [response] = await tasksClient.createTask(request);

    console.log('   ✅ Response queued successfully');
    console.log('   Task ID:', response.name.split('/').pop());
    console.log('============================================\n');

    return response;
  } catch (error) {
    console.error('❌ Failed to queue response:', error);
    throw error;
  }
}

