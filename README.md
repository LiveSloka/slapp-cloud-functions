# Slapp Cloud Function

## 🎯 Overview

**Separate project for Slapp's Google Cloud Function**

This Cloud Function processes evaluation tasks from the `Slapp` queue, sends them to Gemini AI, and queues results in the `SlappResponses` queue.

**Related Projects:**
- Backend: https://github.com/LiveSloka/ajas_backend
- Frontend: https://github.com/LiveSloka/ajas_frontend

---

## 📊 Architecture

```
┌─────────────┐         ┌──────────────────┐
│   Frontend  │────────▶│     Backend      │
└─────────────┘         └──────────────────┘
                                 │
                                 │ Prepare payload
                                 ▼
                        ┌──────────────────┐
                        │  Cloud Tasks     │
                        │  (Slapp queue)   │
                        └──────────────────┘
                                 │
                                 │ HTTP POST
                                 ▼
                        ┌──────────────────┐
                        │  Cloud Function  │◀─ You are here
                        │  processEvaluation│
                        └──────────────────┘
                                 │
                                 │ Process with Gemini
                                 ▼
                        ┌──────────────────┐
                        │   Gemini API     │
                        └──────────────────┘
                                 │
                                 │ Return results
                                 ▼
                        ┌──────────────────┐
                        │  Cloud Tasks     │
                        │(SlappResponses)  │
                        └──────────────────┘
                                 │
                                 │ HTTP POST
                                 ▼
                        ┌──────────────────┐
                        │     Backend      │
                        │  Save to Database│
                        └──────────────────┘
```

---

## 📁 Files

| File | Description |
|------|-------------|
| `index.js` | Main Cloud Function code |
| `package.json` | Dependencies and scripts |
| `env.yaml.template` | Environment variables template |
| `DEPLOYMENT_GUIDE.md` | Complete deployment instructions |
| `README.md` | This file |
| `.gitignore` | Git ignore rules |

---

## 🚀 Quick Start

### 1. Create `.env.yaml`

```bash
cp env.yaml.template .env.yaml
```

Edit `.env.yaml` with your values:
```yaml
GEMINI_API_KEY: 'AIzaSy...your-key'
GCP_PROJECT_ID: 'slapp-478005'
GCP_LOCATION: 'asia-south1'
GCP_TASK_RESPONSES_QUEUE: 'SlappResponses'
BACKEND_SERVICE_URL: 'https://your-backend-url.com'
```

### 2. Deploy

```bash
gcloud functions deploy processEvaluation \
  --gen2 \
  --runtime=nodejs20 \
  --region=asia-south1 \
  --source=. \
  --entry-point=processEvaluation \
  --trigger-http \
  --allow-unauthenticated \
  --env-vars-file=.env.yaml \
  --memory=1GB \
  --timeout=540s \
  --max-instances=10
```

### 3. Get Function URL

Copy the URL from deployment output:
```
https://asia-south1-slapp-478005.cloudfunctions.net/processEvaluation
```

### 4. Update Backend

Add to Backend `.env`:
```env
CLOUD_FUNCTION_URL=https://asia-south1-slapp-478005.cloudfunctions.net/processEvaluation
```

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

