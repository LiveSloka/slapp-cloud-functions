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
  const location = 'us-central1';
  
  // Configure data source for grounding/retrieval
  const dataStoreName = `projects/${projectId}/locations/${location}/dataStores/${VERTEX_AI_DATA_SOURCE_ID}`;
  
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

  // Parse JSON response - handle two-section format (text feedback + JSON)
  let evaluationData;
  
  // Try to extract JSON from markdown code blocks first
  const jsonMatch = text.match(/```json\n([\s\S]*?)\n```/) || text.match(/```\n([\s\S]*?)\n```/);
  
  if (jsonMatch) {
    evaluationData = JSON.parse(jsonMatch[1]);
  } else {
    // Look for JSON object in the response
    const jsonObjMatch = text.match(/\{[\s\S]*"students"[\s\S]*\}/);
    if (jsonObjMatch) {
      evaluationData = JSON.parse(jsonObjMatch[0]);
    } else {
      // Fallback: try parsing entire text as JSON
      evaluationData = JSON.parse(text);
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
    
    // Transform overallFeedback - convert object to string if needed
    let overallFeedbackStr = '';
    if (typeof studentResult.overallFeedback === 'string') {
      overallFeedbackStr = studentResult.overallFeedback;
    } else if (studentResult.overallFeedback && typeof studentResult.overallFeedback === 'object') {
      // Build comprehensive feedback string from object structure
      const feedbackParts = [];
      if (studentResult.overallFeedback.summary) {
        feedbackParts.push(studentResult.overallFeedback.summary);
      }
      if (studentResult.overallFeedback.areasOfImprovement && studentResult.overallFeedback.areasOfImprovement.length > 0) {
        feedbackParts.push(`Areas for Improvement: ${studentResult.overallFeedback.areasOfImprovement.join(', ')}`);
      }
      if (studentResult.overallFeedback.recommendations) {
        feedbackParts.push(`Recommendations: ${studentResult.overallFeedback.recommendations}`);
      }
      overallFeedbackStr = feedbackParts.join('\n\n');
    } else {
      overallFeedbackStr = 'Evaluation completed. Review detailed feedback for each question.';
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
      overallFeedback: overallFeedbackStr,
      // Preserve original overallFeedback object for future use if needed
      overallFeedbackObject: typeof studentResult.overallFeedback === 'object' ? studentResult.overallFeedback : undefined
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

## Output Format

Your response MUST contain TWO sections:

### Section 1: Detailed Marking Reasoning and Feedback (for Non-MCQ questions only)

For every NON-MCQ question, provide:

**Q. [Question Number] ([Section Name]): [Final Marks Awarded] / [M]**

**Feedback:** [Text-based feedback explaining what was correct, where deductions were made, and how to improve. Be brief and point-wise.]

### Section 2: Final Scores JSON Array

Return a JSON array with ALL questions (MCQ and Non-MCQ) in this exact format:

\`\`\`json
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
\`\`\`

**Critical Requirements:**
- For MCQ questions: Set marksAwarded to maxMarks (if correct) or 0 (if wrong). Skip why_marks_awarded, deductions, tiered_feedback for MCQs.
- For Non-MCQ questions: Provide all fields including why_marks_awarded, deductions, tiered_feedback, value_points_matched.
- Use exact max marks from marking scheme.
- Round final marks to nearest 0.5 for consistency.
- Be brief, point-wise, and never invent facts not shown in the answer.
- Return valid JSON only - no markdown outside of the code block.`;
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

