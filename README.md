# Slapp Cloud Function

## 🎯 Overview

**Separate project for Slapp's Google Cloud Functions**

This project contains **TWO Cloud Functions** that work together:
1. **processEvaluation** - Processes tasks from `Slapp` queue with Gemini AI
2. **saveEvaluationResults** - Saves results from `SlappResponses` queue to MongoDB

**✨ Fully Serverless - No backend API calls needed for evaluation processing!**

**Related Projects:**
- Backend: https://github.com/LiveSloka/ajas_backend
- Frontend: https://github.com/LiveSloka/ajas_frontend

---

## 📊 Architecture

```
Frontend: Click "Evaluate"
         ↓
Backend: Queue task
         ↓
    ┌──────────────────┐
    │  Slapp Queue     │ (Cloud Tasks)
    └──────────────────┘
         ↓
    ┌──────────────────────────┐
    │ Cloud Function #1        │
    │ processEvaluation        │
    │ (index.js)               │
    │ - Receives payload       │
    │ - Calls Gemini API       │
    │ - Batches students       │
    └──────────────────────────┘
         ↓
    ┌──────────────────┐
    │  Gemini API      │
    └──────────────────┘
         ↓
    ┌──────────────────┐
    │SlappResponses    │ (Cloud Tasks)
    │Queue             │
    └──────────────────┘
         ↓
    ┌──────────────────────────┐
    │ Cloud Function #2        │
    │ saveEvaluationResults    │
    │ (saveResults.js)         │
    │ - Receives results       │
    │ - Saves to MongoDB       │
    │ - Updates exam status    │
    └──────────────────────────┘
         ↓
    ┌──────────────────┐
    │ MongoDB Database │
    └──────────────────┘
         ↓
Frontend: Polls & shows results
```

---

## 📁 Files

| File | Description |
|------|-------------|
| `index.js` | Cloud Function #1 - Process with Gemini |
| `saveResults.js` | Cloud Function #2 - Save to MongoDB |
| `package.json` | Dependencies and deployment scripts |
| `env.yaml.template` | Environment variables template |
| `DEPLOY_INSTRUCTIONS.md` | **Quick deployment guide** ⭐ |
| `DEPLOYMENT_GUIDE.md` | Detailed deployment instructions |
| `README.md` | This file |
| `.gitignore` | Git ignore rules |

---

## 🚀 Quick Start

### 1. Create `.env.yaml`

```bash
cd "/Users/ram/Enculture Local/Bhargav POCs/Slapp/SlappCloudFunction"
cp env.yaml.template .env.yaml
```

Edit `.env.yaml` with your values:
```yaml
GEMINI_API_KEY: 'AIzaSy...your-key'
MONGODB_URI: 'mongodb+srv://user:pass@cluster.mongodb.net/slapp_database'
GCP_PROJECT_ID: 'slapp-478005'
GCP_LOCATION: 'asia-south1'
GCP_TASK_RESPONSES_QUEUE: 'SlappResponses'
```

**Important:** Use the **SAME** MongoDB URI as your backend!

### 2. Deploy BOTH Functions

```bash
npm run deploy:all
```

This deploys:
- ✅ Cloud Function #1: `processEvaluation` (9 min timeout, 1GB memory)
- ✅ Cloud Function #2: `saveEvaluationResults` (5 min timeout, 512MB memory)

**Wait 10-15 minutes** for deployment to complete.

### 3. Copy Function URL

From deployment output, copy:
```
https://asia-south1-slapp-478005.cloudfunctions.net/processEvaluation
```

### 4. Update Backend

Add to Backend `.env`:
```env
CLOUD_FUNCTION_URL=https://asia-south1-slapp-478005.cloudfunctions.net/processEvaluation
```

Restart backend:
```bash
cd Backend
npm run dev
```

### 5. Test

Create an exam in frontend and click "Evaluate" - everything works automatically! 🎉

---

## 📋 What It Does

### 1. Receives Payload

```javascript
{
  taskType: "evaluation",
  examId: "674abc...",
  tenantId: "T001",
  questionPaper: {
    uri: "gs://...",
    fileName: "question_paper.pdf",
    pageCount: 5
  },
  students: [
    {
      studentId: "123",
      studentName: "John Doe",
      answerSheetUri: "gs://...",
      pageCount: 5
    }
  ],
  markingScheme: {...},
  examMetadata: {...}
}
```

### 2. Processes with Gemini

- Builds evaluation prompt
- Attaches PDFs (question paper, reference docs, answer sheets)
- Calls Gemini API
- Parses JSON response
- Calculates token usage

### 3. Queues Response

```javascript
{
  examId: "674abc...",
  tenantId: "T001",
  evaluationLevel: "standard",
  results: {
    students: {...},
    tokenUsage: {...}
  },
  status: "success",
  processedAt: "2024-11-12T10:30:00Z"
}
```

---

## 🔍 Monitoring

### View Logs

```bash
# Real-time logs
gcloud functions logs read processEvaluation \
  --region=asia-south1 \
  --limit=100 \
  --follow

# Filter by severity
gcloud functions logs read processEvaluation \
  --region=asia-south1 \
  --filter="severity>=ERROR"
```

### Cloud Console

https://console.cloud.google.com/functions/details/asia-south1/processEvaluation?project=slapp-478005

---

## 💰 Pricing

**Cloud Functions Gen 2:**
- First 2M invocations: FREE
- After: $0.40 per million
- Memory: $0.0000025 per GB-second
- CPU: $0.0000100 per GHz-second

**Estimated:**
- 1000 evaluations/month @ 2 min each = ~$2-5/month

---

## 🐛 Troubleshooting

### Function not deploying

```bash
# Enable API
gcloud services enable cloudfunctions.googleapis.com
```

### Permission errors

```bash
# Grant invoker role
gcloud functions add-iam-policy-binding processEvaluation \
  --region=asia-south1 \
  --member="allUsers" \
  --role="roles/cloudfunctions.invoker"
```

### Timeout errors

Increase timeout:
```bash
--timeout=540s  # Max 9 minutes
```

### Memory errors

Increase memory:
```bash
--memory=2GB
```

---

## 📚 See Also

- [DEPLOYMENT_GUIDE.md](./DEPLOYMENT_GUIDE.md) - Complete setup instructions
- [ENV_CONFIGURATION.md](../ENV_CONFIGURATION.md) - Backend environment variables
- [CLOUD_TASKS_ARCHITECTURE.md](../CLOUD_TASKS_ARCHITECTURE.md) - System architecture

---

## ✅ Checklist

Before deploying:
- [ ] `.env.yaml` created with correct values
- [ ] `SlappResponses` queue created
- [ ] Cloud Functions API enabled
- [ ] Gemini API key valid
- [ ] Backend URL correct

After deploying:
- [ ] Function shows ACTIVE status
- [ ] Function URL obtained
- [ ] Backend `.env` updated with function URL
- [ ] Test evaluation completed
- [ ] Logs show successful processing
- [ ] Response queued in SlappResponses

---

**Ready to deploy?** Follow [DEPLOYMENT_GUIDE.md](./DEPLOYMENT_GUIDE.md)!

