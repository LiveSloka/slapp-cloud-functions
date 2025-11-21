# Google Cloud Function Deployment Guide

## 📋 Overview

**Separate project for Slapp's Google Cloud Function**

This Cloud Function processes evaluation tasks from the `Slapp` queue, sends them to Gemini, and queues responses in `SlappResponses`.

**Related Projects:**
- Backend: https://github.com/LiveSloka/ajas_backend
- Frontend: https://github.com/LiveSloka/ajas_frontend

---

## 🏗️ Architecture

```
Frontend → Backend → Cloud Tasks (Slapp queue)
                            ↓
                    Cloud Function (this)
                            ↓
                       Gemini API
                            ↓
                Cloud Tasks (SlappResponses queue)
                            ↓
                    Backend processes results
```

---

## 📦 Prerequisites

1. **Google Cloud Project**: `slapp-478005`
2. **Gemini API Key**: Get from https://aistudio.google.com/apikey
3. **Cloud Tasks API**: Already enabled
4. **Cloud Functions API**: Enable it
5. **Response Queue**: Create `SlappResponses` queue

---

## 🚀 Step-by-Step Deployment

### Step 1: Create Response Queue

```bash
gcloud tasks queues create SlappResponses \
  --location=us-central1 \
  --max-dispatches-per-second=10 \
  --max-concurrent-dispatches=20 \
  --max-attempts=3
```

Or in Console:
- Go to: https://console.cloud.google.com/cloudtasks?project=slapp-478005
- Click "CREATE QUEUE"
- Name: `SlappResponses`
- Region: `us-central1`
- Click "CREATE"

---

### Step 2: Enable Cloud Functions API

```bash
gcloud services enable cloudfunctions.googleapis.com
```

Or in Console:
- Go to: https://console.cloud.google.com/apis/library/cloudfunctions.googleapis.com?project=slapp-478005
- Click "ENABLE"

---

### Step 3: Prepare Environment Variables

Create `.env.yaml` file in `cloud-function/` folder:

```yaml
GEMINI_API_KEY: 'AIzaSy...your-actual-key'
GCP_PROJECT_ID: 'slapp-478005'
GCP_LOCATION: 'us-central1'
GCP_TASK_RESPONSES_QUEUE: 'SlappResponses'
BACKEND_SERVICE_URL: 'https://your-backend-url.com'
```

**Important:** For local testing use your actual backend URL
- Local: `http://localhost:3000`
- Production: `https://your-backend-domain.com`

---

### Step 4: Deploy Cloud Function

```bash
cd cloud-function

gcloud functions deploy processEvaluation \
  --gen2 \
  --runtime=nodejs20 \
  --region=us-central1 \
  --source=. \
  --entry-point=processEvaluation \
  --trigger-http \
  --allow-unauthenticated \
  --env-vars-file=.env.yaml \
  --memory=1GB \
  --timeout=540s \
  --max-instances=10
```

**Parameters explained:**
- `--gen2`: Use 2nd generation Cloud Functions
- `--runtime=nodejs20`: Node.js 20
- `--region=us-central1`: Same as your queues
- `--trigger-http`: HTTP triggered (by Cloud Tasks)
- `--allow-unauthenticated`: For Cloud Tasks to call it
- `--memory=1GB`: Enough for Gemini processing
- `--timeout=540s`: 9 minutes max (evaluation can take time)
- `--max-instances=10`: Scale up to 10 concurrent instances

---

### Step 5: Get Function URL

After deployment, you'll see:

```
Deployed function: processEvaluation
URL: https://us-central1-slapp-478005.cloudfunctions.net/processEvaluation
```

**Copy this URL!** You'll need it for the next step.

---

### Step 6: Update Cloud Tasks Queue Target

Now update the `Slapp` queue to target the Cloud Function:

#### Option A: Using gcloud

```bash
gcloud tasks queues update Slapp \
  --location=us-central1 \
  --max-retry-duration=3600s \
  --min-backoff=10s \
  --max-backoff=300s
```

#### Option B: Update in Backend Code

Update `cloudTasksService.js`:

```javascript
const serviceUrl = process.env.CLOUD_FUNCTION_URL || process.env.BACKEND_SERVICE_URL;
const url = `${serviceUrl}`;  // Cloud Function URL
```

Add to Backend `.env`:
```env
CLOUD_FUNCTION_URL=https://us-central1-slapp-478005.cloudfunctions.net/processEvaluation
```

---

## 🧪 Testing

### Test 1: Check Function is Deployed

```bash
gcloud functions describe processEvaluation --region=us-central1
```

Should show:
```
state: ACTIVE
url: https://us-central1-slapp-478005.cloudfunctions.net/processEvaluation
```

### Test 2: Manual Test Call

```bash
curl -X POST https://us-central1-slapp-478005.cloudfunctions.net/processEvaluation \
  -H "Content-Type: application/json" \
  -d '{
    "examId": "test123",
    "tenantId": "T001",
    "questionPaper": {"uri": "gs://...", "fileName": "test.pdf", "pageCount": 1},
    "students": [{"studentId": "1", "studentName": "Test", "rollNumber": "1", "answerSheetUri": "gs://...", "pageCount": 1}],
    "examMetadata": {"examTitle": "Test", "className": "10", "subjectName": "Math", "examTypeName": "Test", "evaluationLevel": "standard", "language": "english"}
  }'
```

### Test 3: Full Integration Test

1. Start backend
2. Create exam in frontend
3. Click "Evaluate"
4. Check logs:

**Backend logs:**
```
📤 Using Google Cloud Tasks for async evaluation
✅ Evaluation task queued successfully
```

**Cloud Function logs:**
```bash
gcloud functions logs read processEvaluation \
  --region=us-central1 \
  --limit=50
```

Should show:
```
🚀 ============ CLOUD FUNCTION TRIGGERED ============
📦 Payload received
📤 ============ SENDING TO GEMINI ============
📨 ============ QUEUING RESPONSE ============
✅ Response queued successfully
```

---

## 📊 Monitoring

### View Logs

```bash
# Real-time logs
gcloud functions logs read processEvaluation \
  --region=us-central1 \
  --limit=100 \
  --follow

# Filter errors
gcloud functions logs read processEvaluation \
  --region=us-central1 \
  --filter="severity>=ERROR"
```

### Cloud Console

**Function Dashboard:**
https://console.cloud.google.com/functions/details/us-central1/processEvaluation?project=slapp-478005

**View:**
- Invocations count
- Execution time
- Memory usage
- Error rate
- Active instances

---

## 🔧 Update Function

When you modify `index.js`:

```bash
cd cloud-function
gcloud functions deploy processEvaluation \
  --gen2 \
  --runtime=nodejs20 \
  --region=us-central1 \
  --source=. \
  --entry-point=processEvaluation \
  --trigger-http \
  --allow-unauthenticated \
  --env-vars-file=.env.yaml \
  --memory=1GB \
  --timeout=540s
```

Or use the npm script:
```bash
npm run deploy
```

---

## 💰 Pricing

**Cloud Functions (Gen 2):**
- First 2M invocations/month: FREE
- After that: $0.40 per million invocations
- Memory: $0.0000025 per GB-second
- CPU: $0.0000100 per GHz-second

**Example Cost:**
- 1000 evaluations/month
- 2 minutes each
- 1GB memory
- **~$2-5/month**

**Gemini API:**
- As calculated in evaluation (tracked in response)

---

## 🔐 Security

### For Production:

1. **Remove `--allow-unauthenticated`**
2. **Use service account authentication**

```bash
gcloud functions deploy processEvaluation \
  --gen2 \
  --runtime=nodejs20 \
  --region=us-central1 \
  --source=. \
  --entry-point=processEvaluation \
  --trigger-http \
  --service-account=slapp-715@slapp-478005.iam.gserviceaccount.com \
  --env-vars-file=.env.yaml \
  --memory=1GB \
  --timeout=540s
```

3. **Update Cloud Tasks to use OIDC**

In `cloudTasksService.js`:
```javascript
task.httpRequest.oidcToken = {
  serviceAccountEmail: 'slapp-715@slapp-478005.iam.gserviceaccount.com',
  audience: 'https://us-central1-slapp-478005.cloudfunctions.net/processEvaluation'
};
```

---

## 🐛 Troubleshooting

### Error: "Function not found"
**Solution:** Check function name and region match deployment

### Error: "Permission denied"
**Solution:** Grant service account "Cloud Functions Invoker" role

### Error: "Timeout"
**Solution:** Increase timeout (max 540s for gen2):
```bash
--timeout=540s
```

### Error: "Out of memory"
**Solution:** Increase memory:
```bash
--memory=2GB
```

### Error: "Gemini API key invalid"
**Solution:** Check `.env.yaml` has correct GEMINI_API_KEY

---

## 📚 Environment Variables Reference

| Variable | Required | Example | Description |
|----------|----------|---------|-------------|
| `GEMINI_API_KEY` | ✅ Yes | `AIzaSy...` | Your Gemini API key |
| `GCP_PROJECT_ID` | ✅ Yes | `slapp-478005` | GCP project ID |
| `GCP_LOCATION` | ✅ Yes | `us-central1` | Queue region |
| `GCP_TASK_RESPONSES_QUEUE` | ✅ Yes | `SlappResponses` | Response queue name |
| `BACKEND_SERVICE_URL` | ✅ Yes | `https://...` | Backend URL for responses |

---

## ✅ Deployment Checklist

- [ ] Cloud Functions API enabled
- [ ] Response queue `SlappResponses` created
- [ ] `.env.yaml` file created with correct values
- [ ] Function deployed successfully
- [ ] Function URL obtained
- [ ] Backend updated with function URL
- [ ] Test evaluation completed
- [ ] Logs showing successful processing
- [ ] Response queued in `SlappResponses`

---

## 🎉 Success Criteria

Your Cloud Function is working when:

1. ✅ Function shows "ACTIVE" state
2. ✅ Backend queues tasks successfully
3. ✅ Function logs show "CLOUD FUNCTION TRIGGERED"
4. ✅ Gemini processing completes
5. ✅ Response queued in `SlappResponses`
6. ✅ Backend receives and processes response

---

**Need help?** Check logs first:
```bash
gcloud functions logs read processEvaluation --region=us-central1 --limit=100
```

