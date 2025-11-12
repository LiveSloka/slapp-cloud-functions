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

    // Process evaluation with Gemini
    const results = await processWithGemini(payload);

    // Queue response in SlappResponses queue
    await queueResponse({
      examId: payload.examId,
      tenantId: payload.tenantId,
      userId: payload.userId,
      createdBy: payload.createdBy,
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
    console.error('   Error stack:', error.stack);
    
    // Queue error response
    try {
      await queueResponse({
        examId: req.body.examId,
        tenantId: req.body.tenantId,
        userId: req.body.userId,
        createdBy: req.body.createdBy,
        evaluationLevel: req.body.examMetadata?.evaluationLevel,
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
  const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

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
 * Cloud Function will call the saveResults Cloud Function
 */
async function queueResponse(responseData) {
  console.log('\n📨 ============ QUEUING RESPONSE ============');
  
  try {
    const project = process.env.GCP_PROJECT_ID;
    const location = process.env.GCP_LOCATION || 'asia-south1';
    const queue = process.env.GCP_TASK_RESPONSES_QUEUE || 'SlappResponses';
    
    // Cloud Function URL for saving results
    const saveResultsFunctionUrl = process.env.SAVE_RESULTS_FUNCTION_URL || 
      `https://${location}-${project}.cloudfunctions.net/saveEvaluationResults`;

    const parent = tasksClient.queuePath(project, location, queue);

    console.log('   Queue:', queue);
    console.log('   Target Function:', saveResultsFunctionUrl);
    console.log('   Exam ID:', responseData.examId);

    const task = {
      httpRequest: {
        httpMethod: 'POST',
        url: saveResultsFunctionUrl,
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

/**
 * ============================================================
 * CLOUD FUNCTION #2: Save Evaluation Results to MongoDB
 * ============================================================
 * Triggered by SlappResponses queue
 * Saves evaluation results directly to MongoDB
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
    questionType: String,
    maxMarks: Number,
    marksAwarded: Number,
    reasonForMarksAllocation: String,
    rubrics: {
      spellingGrammar: Number,
      creativity: Number,
      clarity: Number,
      depthOfUnderstanding: Number,
      completeness: Number
    }
  }],
  overallFeedback: String,
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
 * Cloud Function #2: Save Evaluation Results
 * Entry point for saving results from SlappResponses queue
 */
exports.saveEvaluationResults = async (req, res) => {
  console.log('\n📨 ============ SAVE RESULTS FUNCTION TRIGGERED ============');
  console.log('   Timestamp:', new Date().toISOString());
  
  try {
    // Connect to database
    await connectToDatabase();
    
    // Extract response payload
    const responseData = req.body;
    
    console.log('📦 Response Data Received:');
    console.log('   Exam ID:', responseData.examId);
    console.log('   Tenant ID:', responseData.tenantId);
    console.log('   Status:', responseData.status);
    console.log('   Students:', responseData.results?.students ? Object.keys(responseData.results.students).length : 0);
    console.log('==========================================================\n');

    // Respond immediately to Cloud Tasks
    res.status(200).json({
      success: true,
      message: 'Results received and saving to database',
      examId: responseData.examId
    });

    // Process response
    if (responseData.status === 'success') {
      console.log('💾 Saving to MongoDB...\n');
      await saveResultsToMongoDB(responseData);
      console.log('\n✅ Saved successfully!\n');
    } else {
      console.error('❌ Evaluation failed:', responseData.error);
      await handleSaveError(responseData);
    }

  } catch (error) {
    console.error('❌ Error:', error);
    
    if (!res.headersSent) {
      res.status(200).json({
        success: false,
        message: 'Error occurred',
        error: error.message
      });
    }
  }
};

async function saveResultsToMongoDB(responseData) {
  const { examId, tenantId, evaluationLevel, results, createdBy } = responseData;

  const exam = await Exam.findOne({ _id: examId, tenantId, softDelete: false });
  if (!exam) throw new Error('Exam not found');

  let maxMarksMap = {};
  if (exam.markingSchemeId) {
    const markingScheme = await MarkingScheme.findById(exam.markingSchemeId);
    if (markingScheme?.approved) {
      markingScheme.sections.forEach(section => {
        section.questions?.forEach(q => {
          maxMarksMap[q.questionNumber] = q.marks;
        });
      });
    }
  }

  const studentsWithAnswers = exam.studentAnswerSheets.filter(s => s.answerSheetUri);
  let successCount = 0;

  for (const studentSheet of studentsWithAnswers) {
    const studentId = studentSheet.studentId.toString();
    const evaluationResult = results.students[studentId];

    if (!evaluationResult?.questions) continue;

    const questionsWithCorrectMaxMarks = evaluationResult.questions.map(q => ({
      ...q,
      maxMarks: maxMarksMap[q.questionNumber] || q.maxMarks
    }));

    const totalMarksAwarded = questionsWithCorrectMaxMarks.reduce((sum, q) => sum + (parseFloat(q.marksAwarded) || 0), 0);
    const totalMaxMarks = questionsWithCorrectMaxMarks.reduce((sum, q) => sum + (parseFloat(q.maxMarks) || 0), 0);
    const percentage = totalMaxMarks > 0 ? (totalMarksAwarded / totalMaxMarks) * 100 : 0;

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

    const createdByValue = createdBy || 'cloud-function';

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

async function handleSaveError(responseData) {
  try {
    const exam = await Exam.findOne({ _id: responseData.examId, tenantId: responseData.tenantId, softDelete: false });
    if (exam) {
      exam.status = 'created';
      exam.updatedBy = 'cloud-function';
      await exam.save();
    }
  } catch (error) {
    console.error('   Error handling save error:', error);
  }
}

