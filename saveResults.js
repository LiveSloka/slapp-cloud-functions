/**
 * Google Cloud Function for Saving Evaluation Results
 * 
 * This function is triggered by Cloud Tasks (SlappResponses queue)
 * - Receives evaluation results from processEvaluation function
 * - Saves directly to MongoDB database
 * - No backend API involvement
 */

const mongoose = require('mongoose');

// MongoDB connection
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

// Define schemas (same as backend models)
const evaluationSchema = new mongoose.Schema({
  examId: { type: mongoose.Schema.Types.ObjectId, required: true },
  studentId: { type: mongoose.Schema.Types.ObjectId, required: true },
  studentName: { type: String, required: true },
  rollNumber: { type: String, required: true },
  className: { type: String, required: true },
  section: { type: String, required: true },
  subjectName: { type: String, required: true },
  examTypeName: { type: String, required: true },
  evaluationLevel: { type: String, required: true },
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
  totalMarksAwarded: { type: Number, required: true },
  totalMaxMarks: { type: Number, required: true },
  percentage: { type: Number, required: true },
  aggregateRubrics: {
    averageSpellingGrammar: Number,
    averageCreativity: Number,
    averageClarity: Number,
    averageDepthOfUnderstanding: Number,
    averageCompleteness: Number,
    overallAverageRubricScore: Number
  },
  status: { type: String, default: 'completed' },
  evaluatedAt: { type: Date, default: Date.now },
  tenantId: { type: String, required: true },
  createdBy: { type: String, required: true },
  updatedBy: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
  softDelete: { type: Boolean, default: false }
}, { timestamps: true });

const examResultSchema = new mongoose.Schema({
  examId: { type: mongoose.Schema.Types.ObjectId, required: true },
  studentId: { type: mongoose.Schema.Types.ObjectId, required: true },
  studentName: { type: String, required: true },
  rollNumber: { type: String, required: true },
  className: { type: String, required: true },
  section: { type: String, required: true },
  subjectId: { type: mongoose.Schema.Types.ObjectId, required: true },
  subjectName: { type: String, required: true },
  examTypeId: { type: mongoose.Schema.Types.ObjectId, required: true },
  examTypeName: { type: String, required: true },
  examDate: { type: Date },
  evaluationLevel: { type: String, required: true },
  marksObtained: { type: Number, required: true },
  totalMarks: { type: Number, required: true },
  percentage: { type: Number, required: true },
  grade: { type: String, required: true },
  status: { type: String, required: true },
  tenantId: { type: String, required: true },
  createdBy: { type: String, required: true },
  updatedBy: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
  softDelete: { type: Boolean, default: false }
}, { timestamps: true });

const examSchema = new mongoose.Schema({
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
  updatedBy: String,
  updatedAt: Date
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

// Models
const Evaluation = mongoose.models.Evaluation || mongoose.model('Evaluation', evaluationSchema);
const ExamResult = mongoose.models.ExamResult || mongoose.model('ExamResult', examResultSchema);
const Exam = mongoose.models.Exam || mongoose.model('Exam', examSchema);
const ExamType = mongoose.models.ExamType || mongoose.model('ExamType', examTypeSchema);
const MarkingScheme = mongoose.models.MarkingScheme || mongoose.model('MarkingScheme', markingSchemeSchema);

/**
 * Main Cloud Function Entry Point
 * Triggered by Cloud Tasks from SlappResponses queue
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
    console.log('   Evaluation Level:', responseData.evaluationLevel);
    console.log('   Students:', responseData.results?.students ? Object.keys(responseData.results.students).length : 0);
    console.log('   Processed At:', responseData.processedAt);
    console.log('==========================================================\n');

    // Respond immediately to Cloud Tasks
    res.status(200).json({
      success: true,
      message: 'Results received and saving to database',
      examId: responseData.examId
    });

    // Process response
    if (responseData.status === 'success') {
      console.log('💾 Saving evaluation results to MongoDB...\n');
      await saveResults(responseData);
      console.log('\n✅ All results saved successfully to database!\n');
    } else {
      console.error('❌ Evaluation failed:', responseData.error);
      await handleEvaluationError(responseData);
    }

  } catch (error) {
    console.error('❌ Error in save function:', error);
    
    // Still respond to Cloud Tasks to prevent retry
    if (!res.headersSent) {
      res.status(200).json({
        success: false,
        message: 'Error occurred but acknowledged to prevent retry',
        error: error.message
      });
    }
  }
};

/**
 * Save evaluation results to MongoDB
 * Uses exact same logic as backend taskController.js
 */
async function saveResults(responseData) {
  try {
    const { examId, tenantId, evaluationLevel, results, createdBy } = responseData;

    // Get exam from database
    console.log('   📚 Fetching exam from database...');
    const exam = await Exam.findOne({ _id: examId, tenantId, softDelete: false });
    if (!exam) {
      throw new Error('Exam not found in database');
    }
    console.log('   ✅ Exam found:', exam.examTitle || examId);

    // Get marking scheme for max marks mapping
    let markingScheme = null;
    let maxMarksMap = {};
    
    if (exam.markingSchemeId) {
      console.log('   📋 Fetching marking scheme...');
      markingScheme = await MarkingScheme.findById(exam.markingSchemeId);
      
      if (markingScheme && markingScheme.approved && markingScheme.sections) {
        markingScheme.sections.forEach(section => {
          if (section.questions) {
            section.questions.forEach(question => {
              maxMarksMap[question.questionNumber] = question.marks;
            });
          }
        });
        console.log(`   ✅ Max marks mapping created for ${Object.keys(maxMarksMap).length} questions`);
      }
    }

    // Get students with answer sheets
    const studentsWithAnswers = exam.studentAnswerSheets.filter(s => s.answerSheetUri);
    console.log(`   👥 Processing ${studentsWithAnswers.length} students\n`);
    
    // Save results for each student
    let successCount = 0;
    let failCount = 0;

    for (const studentSheet of studentsWithAnswers) {
      const studentId = studentSheet.studentId.toString();
      const evaluationResult = results.students[studentId];

      if (!evaluationResult || !evaluationResult.questions) {
        console.error(`   ❌ No result for ${studentSheet.studentName}`);
        failCount++;
        continue;
      }

      try {
        // Sanitize rubric scores
        const sanitizeRubricValue = (value) => {
          if (typeof value === 'number' && !isNaN(value)) return value;
          if (typeof value === 'string') {
            const parsed = parseFloat(value);
            if (!isNaN(parsed) && parsed >= 0 && parsed <= 10) return parsed;
          }
          return 0;
        };

        // Replace maxMarks with values from marking scheme if available
        const questionsWithCorrectMaxMarks = evaluationResult.questions.map(question => {
          const correctedQuestion = { ...question };
          
          if (maxMarksMap[question.questionNumber] !== undefined) {
            correctedQuestion.maxMarks = maxMarksMap[question.questionNumber];
          }
          
          return correctedQuestion;
        });

        // Calculate totals
        const totalMarksAwarded = questionsWithCorrectMaxMarks.reduce((sum, q) => sum + (parseFloat(q.marksAwarded) || 0), 0);
        const totalMaxMarks = questionsWithCorrectMaxMarks.reduce((sum, q) => sum + (parseFloat(q.maxMarks) || 0), 0);
        const percentage = totalMaxMarks > 0 ? (totalMarksAwarded / totalMaxMarks) * 100 : 0;

        // Aggregate rubrics
        let aggregateRubrics = {
          averageSpellingGrammar: sanitizeRubricValue(evaluationResult.overallRubrics?.spellingGrammar),
          averageCreativity: sanitizeRubricValue(evaluationResult.overallRubrics?.creativity),
          averageClarity: sanitizeRubricValue(evaluationResult.overallRubrics?.clarity),
          averageDepthOfUnderstanding: sanitizeRubricValue(evaluationResult.overallRubrics?.depthOfUnderstanding),
          averageCompleteness: sanitizeRubricValue(evaluationResult.overallRubrics?.completeness),
          overallAverageRubricScore: 0
        };

        const totalRubricScore = aggregateRubrics.averageSpellingGrammar + 
                                aggregateRubrics.averageCreativity + 
                                aggregateRubrics.averageClarity + 
                                aggregateRubrics.averageDepthOfUnderstanding + 
                                aggregateRubrics.averageCompleteness;
        aggregateRubrics.overallAverageRubricScore = parseFloat((totalRubricScore / 5).toFixed(2));

        // Determine grade
        const percentageValue = parseFloat(percentage.toFixed(2));
        let grade = 'F';
        if (percentageValue >= 90) grade = 'A+';
        else if (percentageValue >= 80) grade = 'A';
        else if (percentageValue >= 70) grade = 'B+';
        else if (percentageValue >= 60) grade = 'B';
        else if (percentageValue >= 50) grade = 'C';
        else if (percentageValue >= 40) grade = 'D';

        // Get pass/fail status
        const examType = await ExamType.findOne({ _id: exam.examTypeId, tenantId, softDelete: false });
        const passMarks = examType ? examType.passMarks : 40;
        const maximumMarks = examType ? examType.maximumMarks : 100;
        const passPercentage = (passMarks / maximumMarks) * 100;
        const status = percentageValue >= passPercentage ? 'pass' : 'fail';

        const createdByValue = createdBy || responseData.userId || 'cloud-function';

        // Save evaluation
        const evaluation = new Evaluation({
          examId: exam._id,
          studentId: studentSheet.studentId,
          studentName: studentSheet.studentName,
          rollNumber: studentSheet.rollNumber,
          className: exam.className,
          section: exam.section,
          subjectName: exam.subjectName,
          examTypeName: exam.examTypeName,
          evaluationLevel: evaluationLevel,
          questions: questionsWithCorrectMaxMarks,
          overallFeedback: evaluationResult.overallFeedback,
          totalMarksAwarded,
          totalMaxMarks,
          percentage: percentageValue,
          aggregateRubrics,
          status: 'completed',
          evaluatedAt: new Date(),
          tenantId,
          createdBy: createdByValue,
          updatedBy: createdByValue
        });

        await evaluation.save();

        // Save to ExamResult collection (for dashboard metrics)
        const examResult = new ExamResult({
          examId: exam._id,
          studentId: studentSheet.studentId,
          studentName: studentSheet.studentName,
          rollNumber: studentSheet.rollNumber,
          className: exam.className,
          section: exam.section,
          subjectId: exam.subjectId,
          subjectName: exam.subjectName,
          examTypeId: exam.examTypeId,
          examTypeName: exam.examTypeName,
          examDate: exam.examDate,
          evaluationLevel: evaluationLevel,
          marksObtained: totalMarksAwarded,
          totalMarks: totalMaxMarks,
          percentage: percentageValue,
          grade,
          status,
          tenantId,
          createdBy: createdByValue,
          updatedBy: createdByValue
        });

        await examResult.save();
        successCount++;
        
        console.log(`   ✅ ${studentSheet.studentName}: ${totalMarksAwarded}/${totalMaxMarks} (${percentageValue}%) - Grade: ${grade}`);
      } catch (error) {
        console.error(`   ❌ Error saving ${studentSheet.studentName}:`, error.message);
        failCount++;
      }
    }

    // Update exam status and token usage
    console.log('\n   📊 Updating exam status and token usage...');
    exam.status = 'evaluated';
    
    if (results.tokenUsage) {
      exam.tokenUsage = {
        promptTokens: results.tokenUsage.promptTokens || 0,
        outputTokens: results.tokenUsage.outputTokens || 0,
        totalTokens: results.tokenUsage.totalTokens || 0,
        inputCost: results.tokenUsage.inputCost || 0,
        outputCost: results.tokenUsage.outputCost || 0,
        totalCost: results.tokenUsage.totalCost || 0
      };
      
      if (!exam.evaluatedLevels) exam.evaluatedLevels = [];
      const levelIndex = exam.evaluatedLevels.findIndex(el => el.level === evaluationLevel);
      
      if (levelIndex >= 0) {
        exam.evaluatedLevels[levelIndex] = {
          level: evaluationLevel,
          evaluatedAt: new Date(),
          tokenUsage: exam.tokenUsage
        };
      } else {
        exam.evaluatedLevels.push({
          level: evaluationLevel,
          evaluatedAt: new Date(),
          tokenUsage: exam.tokenUsage
        });
      }
      
      console.log(`   💰 Token usage saved: ${exam.tokenUsage.totalTokens.toLocaleString()} tokens, $${exam.tokenUsage.totalCost.toFixed(6)}`);
    }
    
    exam.updatedBy = createdByValue;
    exam.updatedAt = new Date();
    await exam.save();

    console.log(`   ✅ Exam status updated to: ${exam.status}`);
    console.log(`   ✅ Evaluation level '${evaluationLevel}' tracked\n`);

    console.log('   📊 SAVE SUMMARY:');
    console.log(`      ✅ Successful: ${successCount}/${studentsWithAnswers.length}`);
    console.log(`      ❌ Failed: ${failCount}/${studentsWithAnswers.length}`);
    console.log(`      📈 Success Rate: ${((successCount / studentsWithAnswers.length) * 100).toFixed(1)}%`);

  } catch (error) {
    console.error('❌ Error saving results:', error);
    throw error;
  }
}

/**
 * Handle evaluation error
 */
async function handleEvaluationError(responseData) {
  try {
    console.log('   🔄 Handling evaluation error...');
    
    const exam = await Exam.findOne({ 
      _id: responseData.examId, 
      tenantId: responseData.tenantId, 
      softDelete: false 
    });
    
    if (exam) {
      exam.status = 'created';
      exam.updatedBy = responseData.createdBy || 'cloud-function';
      exam.updatedAt = new Date();
      await exam.save();
      console.log('   ✅ Exam status reset to "created"');
    }
  } catch (error) {
    console.error('   ❌ Error handling evaluation error:', error);
  }
}

