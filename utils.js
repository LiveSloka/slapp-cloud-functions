/**
 * Shared utilities for Cloud Functions
 */

const mongoose = require('mongoose');
const { VertexAI } = require('@google-cloud/vertexai');
const { Storage } = require('@google-cloud/storage');

// ============================================================================
// VERTEX AI CONFIGURATION
// ============================================================================
const VERTEX_AI_DATA_SOURCE_ID = 'cbse-bot-datastore_1763268237153';

// Initialize Vertex AI
const vertexAI = new VertexAI({
  project: process.env.GCP_PROJECT_ID || 'slapp-478005',
  location: 'us-central1'
});

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

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

// Initialize Google Cloud Storage
const storage = new Storage({
  projectId: process.env.GCP_PROJECT_ID || 'slapp-478005'
});

const GCS_BUCKET_NAME = process.env.GCS_BUCKET_NAME || 'slapp-evaluation-files';
const bucket = storage.bucket(GCS_BUCKET_NAME);

/**
 * Upload marking scheme JSON to Google Cloud Storage as TXT file (for Vertex AI compatibility)
 * @param {Object} jsonData - JSON object to upload
 * @param {string} fileName - File name (without extension)
 * @param {string} folder - Folder path in bucket (default: 'question-paper-schemes')
 * @returns {Promise<string>} - GCS URI (gs://bucket/path/to/file.txt)
 */
async function uploadMarkingSchemeJSONToGCS(jsonData, fileName, folder = 'question-paper-schemes') {
  try {
    const timestamp = Date.now();
    const sanitizedFileName = fileName.replace(/[^a-zA-Z0-9.-]/g, '_');
    const txtFileName = `${folder}/${timestamp}-${sanitizedFileName}.txt`;
    const file = bucket.file(txtFileName);
    
    // Convert JSON to formatted text string (Vertex AI supports TXT format)
    const jsonString = JSON.stringify(jsonData, null, 2);
    const txtBuffer = Buffer.from(jsonString, 'utf-8');
    
    // Upload to GCS as TXT file
    await file.save(txtBuffer, {
      metadata: {
        contentType: 'text/plain',
        metadata: {
          originalName: fileName,
          uploadedAt: new Date().toISOString(),
          format: 'txt',
          dataType: 'json'
        }
      },
      resumable: false
    });
    
    const gsUri = `gs://${GCS_BUCKET_NAME}/${txtFileName}`;
    console.log(`   ✅ Marking scheme JSON uploaded to GCS as TXT: ${gsUri}`);
    
    return gsUri;
  } catch (error) {
    console.error('   ❌ Error uploading marking scheme JSON to GCS:', error);
    throw new Error(`Failed to upload marking scheme JSON to GCS: ${error.message}`);
  }
}

/**
 * Load marking scheme JSON from GCS
 */
async function loadMarkingSchemeFromGCS(gsUri) {
  try {
    // Extract bucket and file path from gs:// URI
    const uriMatch = gsUri.match(/^gs:\/\/([^\/]+)\/(.+)$/);
    if (!uriMatch) {
      throw new Error(`Invalid GCS URI format: ${gsUri}`);
    }
    
    const [, bucketName, filePath] = uriMatch;
    const storageInstance = new Storage({
      projectId: process.env.GCP_PROJECT_ID || 'slapp-478005'
    });
    const bucketInstance = storageInstance.bucket(bucketName);
    const file = bucketInstance.file(filePath);
    
    console.log(`   📥 Loading from: ${bucketName}/${filePath}`);
    
    // Download file content
    const [fileContent] = await file.download();
    const jsonString = fileContent.toString('utf-8');
    const markingScheme = JSON.parse(jsonString);
    
    console.log(`   ✅ Loaded marking scheme: ${markingScheme.examTitle || 'Untitled'}`);
    return markingScheme;
  } catch (error) {
    console.error('❌ Error loading marking scheme from GCS:', error);
    throw new Error(`Failed to load marking scheme: ${error.message}`);
  }
}

// ============================================================================
// MONGODB CONNECTION
// ============================================================================

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

// ============================================================================
// MONGODB SCHEMAS
// ============================================================================

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
  softDelete: { type: Boolean, default: false },
  rawResponse: { type: String }
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
  examId: mongoose.Schema.Types.ObjectId,
  tenantId: { type: String, required: true, index: true },
  examTitle: String,
  totalMarks: Number,
  className: String,
  section: String,
  subjectName: String,
  examTypeName: String,
  examDate: Date,
  language: String,
  sections: [{
    sectionName: String,
    sectionTotalMarks: Number,
    questions: [{
      questionNumber: String,
      marks: Number,
      description: String,
      questionText: String,
      questionType: String,
      valuePoints: [{
        step_id: { type: Number, required: true },
        description: { type: String, required: true },
        expected_ocr_match: { type: String, default: '' },
        marks: { type: Number, default: 0.5 }
      }],
      stepMarks: [Number],
      options: [{
        label: String,
        text: String
      }],
      correctOption: String,
      correctAnswer: String,
      modelAnswer: String
    }]
  }],
  questionPaperUri: String,
  questionPaperName: String,
  questionPaperPageCount: Number,
  approved: { type: Boolean, default: false },
  status: { type: String, enum: ['draft', 'approved', 'rejected', 'parse_failed'], default: 'draft' },
  tokenUsage: {
    promptTokens: Number,
    outputTokens: Number,
    totalTokens: Number,
    inputCost: Number,
    outputCost: Number,
    totalCost: Number
  },
  createdBy: String,
  updatedBy: String,
  softDelete: { type: Boolean, default: false },
  rawResponse: { type: String }
}, { timestamps: true });

const questionPaperSchema = new mongoose.Schema({
  tenantId: { type: String, required: true, index: true },
  questionPaperUri: { type: String, required: true, index: true },
  questionPaperName: { type: String, default: '' },
  examTitle: { type: String, default: '' },
  totalMarks: { type: Number, default: 0 },
  subjectName: { type: String, default: '' },
  className: { type: String, default: '' },
  language: {
    type: String,
    enum: ['english', 'hindi', 'kannada', 'telugu', 'tamil', 'malayalam', 'marathi', 'bengali', 'gujarati', 'punjabi', 'other'],
    default: 'english'
  },
  sections: [{
    sectionName: { type: String, required: true },
    sectionTotalMarks: { type: Number, required: true },
    questions: [{
      questionNumber: { type: String, required: true },
      questionText: { type: String, default: '' },
      questionType: { type: String, default: '' },
      marks: { type: Number, required: true },
      options: [{
        option: { type: String, default: '' },
        text: { type: String, default: '' }
      }],
      correctOption: { type: String, default: '' },
      correctAnswer: { type: String, default: '' },
      valuePoints: [{
        step_id: { type: Number, required: true },
        description: { type: String, required: true },
        expected_ocr_match: { type: String, default: '' },
        marks: { type: Number, default: 0.5 }
      }],
      stepMarks: { type: [Number], default: [] }
    }]
  }],
  rawResponse: { type: String, default: '' },
  status: {
    type: String,
    enum: ['draft', 'approved', 'parse_failed'],
    default: 'draft'
  },
  createdBy: { type: String, default: 'system' },
  updatedBy: { type: String, default: 'system' },
  softDelete: { type: Boolean, default: false, index: true }
}, { timestamps: true });

// AnswerSheetEvaluation schema
const answerSheetEvaluationSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  questionPaperUri: {
    type: String,
    required: true,
    index: true
  },
  answerSheetUri: {
    type: String,
    required: true,
    index: true
  },
  studentName: {
    type: String,
    default: 'Student'
  },
  evaluationData: {
    questions: [{
      questionNumber: {
        type: String,
        required: true
      },
      steps: [{
        step_id: {
          type: Number,
          required: true
        },
        marksAwarded: {
          type: Number,
          default: 0
        },
        description: {
          type: String,
          default: ''
        }
      }],
      totalMarks: {
        type: Number,
        default: 0
      }
    }],
    grandTotal: {
      type: Number,
      default: 0
    }
  },
  tokenUsage: {
    promptTokens: {
      type: Number,
      default: 0
    },
    candidatesTokens: {
      type: Number,
      default: 0
    },
    totalTokens: {
      type: Number,
      default: 0
    },
    totalCost: {
      type: Number,
      default: 0
    }
  },
  rawResponse: {
    type: String,
    default: ''
  },
  createdBy: {
    type: String,
    default: 'system'
  },
  updatedBy: {
    type: String,
    default: 'system'
  },
  softDelete: {
    type: Boolean,
    default: false,
    index: true
  }
}, {
  timestamps: true
});

// Indexes for faster queries
answerSheetEvaluationSchema.index({ tenantId: 1, questionPaperUri: 1 });
answerSheetEvaluationSchema.index({ tenantId: 1, answerSheetUri: 1 });
answerSheetEvaluationSchema.index({ tenantId: 1, softDelete: 1 });
answerSheetEvaluationSchema.index({ questionPaperUri: 1, answerSheetUri: 1 });

// Mongoose models
const Evaluation = mongoose.models.Evaluation || mongoose.model('Evaluation', evaluationSchema);
const ExamResult = mongoose.models.ExamResult || mongoose.model('ExamResult', examResultSchema);
const Exam = mongoose.models.Exam || mongoose.model('Exam', examSchema);
const ExamType = mongoose.models.ExamType || mongoose.model('ExamType', examTypeSchema);
const MarkingScheme = mongoose.models.MarkingScheme || mongoose.model('MarkingScheme', markingSchemeSchema);
const QuestionPaper = mongoose.models.QuestionPaper || mongoose.model('QuestionPaper', questionPaperSchema);
const AnswerSheetEvaluation = mongoose.models.AnswerSheetEvaluation || mongoose.model('AnswerSheetEvaluation', answerSheetEvaluationSchema);

// ============================================================================
// MONGODB SAVE FUNCTIONS
// ============================================================================

/**
 * Save marking scheme to MongoDB
 */
async function saveMarkingSchemeToMongoDB({ payload, markingScheme, rawResponse, status, tenantId, createdBy, tokenUsage }) {
  const markingSchemeDoc = new MarkingScheme({
    examId: payload.examId || null,
    tenantId: tenantId || payload.tenantId,
    examTitle: markingScheme?.examTitle || payload.questionPaperName || 'Question Paper',
    totalMarks: markingScheme?.totalMarks || 0,
    className: payload.className || null,
    section: payload.section || null,
    subjectName: payload.subjectName || null,
    examTypeName: payload.examTypeName || null,
    examDate: payload.examDate || null,
    language: payload.language || 'english',
    sections: markingScheme?.sections || [],
    questionPaperUri: payload.questionPaperUri,
    questionPaperName: payload.questionPaperName || '',
    questionPaperPageCount: payload.questionPaperPageCount || 0,
    status: status || 'draft',
    rawResponse: rawResponse || '',
    tokenUsage: tokenUsage || null,
    createdBy: createdBy || payload.createdBy || 'cloud-function',
    updatedBy: createdBy || payload.createdBy || 'cloud-function'
  });

  await markingSchemeDoc.save();
  console.log(`✅ Marking scheme saved to MongoDB: ${markingSchemeDoc._id}`);
  return markingSchemeDoc;
}

/**
 * Save question paper to MongoDB
 */
async function saveQuestionPaperToMongoDB({ payload, questionPaperData, rawResponse, status, tenantId, createdBy }) {
  try {
    if (!payload || !payload.questionPaperUri) {
      throw new Error('Invalid payload: questionPaperUri is required');
    }

    const currentTenantId = tenantId || payload.tenantId;
    if (!currentTenantId) {
      throw new Error('Invalid payload: tenantId is required');
    }

    console.log(`   💾 Saving question paper to MongoDB: ${payload.questionPaperUri}`);

    // Prepare marking scheme JSON data for upload
    let markingSchemeJsonUri = '';
    if (questionPaperData) {
      try {
        // Generate file name
        const fileName = `marking-scheme-${questionPaperData.examTitle || 'question-paper'}-${payload.questionPaperUri.split('/').pop().replace(/\.pdf$/i, '')}`;
        
        // Upload marking scheme JSON to GCS
        markingSchemeJsonUri = await uploadMarkingSchemeJSONToGCS(
          questionPaperData,
          fileName,
          'question-paper-schemes'
        );
        console.log(`   ✅ Marking scheme JSON uploaded to GCS: ${markingSchemeJsonUri}`);
      } catch (uploadError) {
        console.error(`   ⚠️  Failed to upload marking scheme JSON to GCS:`, uploadError);
        // Continue saving to database even if upload fails
      }
    }

    // Check if question paper already exists
    const existingQuestionPaper = await QuestionPaper.findOne({
      questionPaperUri: payload.questionPaperUri,
      tenantId: currentTenantId,
      softDelete: false
    });

    const questionPaperDoc = {
      tenantId: currentTenantId,
      questionPaperUri: payload.questionPaperUri,
      questionPaperName: payload.questionPaperName || payload.questionPaperUri.split('/').pop() || '',
      examTitle: questionPaperData?.examTitle || payload.questionPaperName || 'Question Paper',
      totalMarks: questionPaperData?.totalMarks || 0,
      subjectName: payload.subjectName || '',
      className: payload.className || '',
      language: payload.language || 'english',
      sections: questionPaperData?.sections || [],
      rawResponse: rawResponse || '',
      markingSchemeJsonUri: markingSchemeJsonUri,
      status: status || 'draft',
      createdBy: createdBy || payload.createdBy || 'cloud-function',
      updatedBy: createdBy || payload.createdBy || 'cloud-function',
      softDelete: false
    };

    let savedDoc;
    if (existingQuestionPaper) {
      // Update existing document
      Object.assign(existingQuestionPaper, questionPaperDoc);
      savedDoc = await existingQuestionPaper.save();
      console.log(`   ✅ Question paper updated in MongoDB: ${savedDoc._id}`);
      console.log(`   📊 Sections: ${savedDoc.sections?.length || 0}, Total Questions: ${savedDoc.sections?.reduce((sum, s) => sum + (s.questions?.length || 0), 0) || 0}`);
      if (markingSchemeJsonUri) {
        console.log(`   📁 JSON URI: ${markingSchemeJsonUri}`);
      }
    } else {
      // Create new document
      savedDoc = await QuestionPaper.create(questionPaperDoc);
      console.log(`   ✅ Question paper saved to MongoDB: ${savedDoc._id}`);
      console.log(`   📊 Sections: ${savedDoc.sections?.length || 0}, Total Questions: ${savedDoc.sections?.reduce((sum, s) => sum + (s.questions?.length || 0), 0) || 0}`);
      if (markingSchemeJsonUri) {
        console.log(`   📁 JSON URI: ${markingSchemeJsonUri}`);
      }
    }

    return savedDoc;
  } catch (error) {
    console.error(`   ❌ Error saving question paper to MongoDB:`, error);
    throw error;
  }
}

/**
 * Save answer sheet evaluation to MongoDB
 */
async function saveAnswerSheetEvaluationToMongoDB({ tenantId, questionPaperUri, answerSheetUri, studentName, evaluationData, tokenUsage, rawResponse, createdBy }) {
  try {
    if (!tenantId) {
      throw new Error('Invalid payload: tenantId is required');
    }
    if (!questionPaperUri) {
      throw new Error('Invalid payload: questionPaperUri is required');
    }
    if (!answerSheetUri) {
      throw new Error('Invalid payload: answerSheetUri is required');
    }

    console.log(`   💾 Saving answer sheet evaluation to MongoDB: ${answerSheetUri}`);

    // Check if evaluation already exists
    const existingEvaluation = await AnswerSheetEvaluation.findOne({
      tenantId: tenantId,
      questionPaperUri: questionPaperUri,
      answerSheetUri: answerSheetUri,
      softDelete: false
    });

    const evaluationDoc = {
      tenantId: tenantId,
      questionPaperUri: questionPaperUri,
      answerSheetUri: answerSheetUri,
      studentName: studentName || 'Student',
      evaluationData: evaluationData || { questions: [], grandTotal: 0 },
      tokenUsage: tokenUsage || null,
      rawResponse: rawResponse || '',
      createdBy: createdBy || 'cloud-function',
      updatedBy: createdBy || 'cloud-function',
      softDelete: false
    };

    let savedDoc;
    if (existingEvaluation) {
      // Update existing document
      Object.assign(existingEvaluation, evaluationDoc);
      savedDoc = await existingEvaluation.save();
      console.log(`   ✅ Answer sheet evaluation updated in MongoDB: ${savedDoc._id}`);
    } else {
      // Create new document
      savedDoc = await AnswerSheetEvaluation.create(evaluationDoc);
      console.log(`   ✅ Answer sheet evaluation saved to MongoDB: ${savedDoc._id}`);
    }

    return savedDoc;
  } catch (error) {
    console.error('   ❌ Error saving answer sheet evaluation to MongoDB:', error);
    throw error;
  }
}

/**
 * Save evaluation results to MongoDB
 */
async function saveResultsToMongoDB(responseData) {
  const { examId, tenantId, evaluationLevel, results, createdBy, rawResponse } = responseData;
  
  const createdByValue = createdBy || 'cloud-function';

  const exam = await Exam.findOne({ _id: examId, tenantId, softDelete: false });
  if (!exam) throw new Error('Exam not found');

  // Build max marks mapping and section mapping from approved marking scheme
  let maxMarksMap = {};
  let sectionMap = {};
  let schemeTotalMarks = null;
  
  if (exam.markingSchemeId) {
    const markingScheme = await MarkingScheme.findById(exam.markingSchemeId);
    if (markingScheme?.approved) {
      schemeTotalMarks = markingScheme.totalMarks;
      markingScheme.sections.forEach(section => {
        section.questions?.forEach(q => {
          maxMarksMap[q.questionNumber] = q.marks;
          sectionMap[q.questionNumber] = section.sectionName;
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

    // Use marking scheme max marks and section
    const questionsWithCorrectMaxMarks = evaluationResult.questions.map(q => {
      const correctedQuestion = {
        ...q,
        maxMarks: maxMarksMap[q.questionNumber] || q.maxMarks
      };
      
      if (sectionMap[q.questionNumber]) {
        correctedQuestion.section = sectionMap[q.questionNumber];
      } else if (!correctedQuestion.section || correctedQuestion.section === 'General' || correctedQuestion.section === 'N/A') {
        correctedQuestion.section = correctedQuestion.section || 'General';
      }
      
      return correctedQuestion;
    });

    const totalMarksAwarded = questionsWithCorrectMaxMarks.reduce((sum, q) => sum + (parseFloat(q.marksAwarded) || 0), 0);
    const totalMaxMarks = schemeTotalMarks || questionsWithCorrectMaxMarks.reduce((sum, q) => sum + (parseFloat(q.maxMarks) || 0), 0);
    const percentage = totalMaxMarks > 0 ? (totalMarksAwarded / totalMaxMarks) * 100 : 0;
    
    console.log(`   📊 ${studentSheet.studentName}: ${totalMarksAwarded}/${totalMaxMarks} (${percentage.toFixed(2)}%)`);

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
      status: 'completed', evaluatedAt: new Date(), tenantId, createdBy: createdByValue, updatedBy: createdByValue,
      rawResponse: rawResponse
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

/**
 * Handle save errors
 */
async function handleSaveError(errorData) {
  try {
    const exam = await Exam.findOne({ _id: errorData.examId, tenantId: errorData.tenantId, softDelete: false });
    if (exam) {
      exam.status = 'created';
      exam.updatedBy = 'cloud-function';
      await exam.save();
      console.log(`   ✅ Exam status reset to 'created' due to error`);
    }
  } catch (error) {
    console.error('   ❌ Error handling save error:', error);
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  // Vertex AI
  vertexAI,
  VERTEX_AI_DATA_SOURCE_ID,
  
  // Helper functions
  retryWithBackoff,
  calculateTokenCost,
  loadMarkingSchemeFromGCS,
  
  // Database
  connectToDatabase,
  
  // Save functions
  saveMarkingSchemeToMongoDB,
  saveQuestionPaperToMongoDB,
  saveResultsToMongoDB,
  saveAnswerSheetEvaluationToMongoDB,
  handleSaveError,
  
  // Models
  AnswerSheetEvaluation
};

