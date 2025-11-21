# Complete Deployment Instructions

## 🎯 Overview

This project contains **TWO Cloud Functions** that work together:

1. **`processEvaluation`** - Reads from `Slapp` queue → Sends to Gemini
2. **`saveEvaluationResults`** - Reads from `SlappResponses` queue → Saves to MongoDB

**No backend API involvement in processing!** Everything is serverless.

---

## 📊 Complete Architecture

```
Frontend: Click "Evaluate"
         ↓
Backend: Queue task
         ↓
    ┌─────────────────────┐
    │  Slapp Queue        │ (Cloud Tasks)
    └─────────────────────┘
         ↓
    ┌─────────────────────┐
    │ Cloud Function #1   │ processEvaluation
    │ - Receives payload  │
    │ - Calls Gemini API  │
    │ - Returns results   │
    └─────────────────────┘
         ↓
    ┌─────────────────────┐
    │SlappResponses Queue │ (Cloud Tasks)
    └─────────────────────┘
         ↓
    ┌─────────────────────┐
    │ Cloud Function #2   │ saveEvaluationResults
    │ - Receives results  │
    │ - Saves to MongoDB  │
    │ - Updates exam      │
    └─────────────────────┘
         ↓
    ┌─────────────────────┐
    │  MongoDB Database   │
    └─────────────────────┘
         ↓
Frontend: Polls status → Shows results
```

---

## 🚀 Step-by-Step Deployment

### ✅ Prerequisites

Before starting, ensure you have:

- [x] Google Cloud account with project: `slapp-478005`
- [x] gcloud CLI installed ([Install Guide](https://cloud.google.com/sdk/docs/install))
- [x] Authenticated: `gcloud auth login`
- [x] Project set: `gcloud config set project slapp-478005`

---

### Step 1: Enable Required APIs

```bash
# Enable Cloud Functions API
gcloud services enable cloudfunctions.googleapis.com --project=slapp-478005

# Enable Cloud Build API (required for deployment)
gcloud services enable cloudbuild.googleapis.com --project=slapp-478005

# Enable Cloud Run API (required for Gen 2 functions)
gcloud services enable run.googleapis.com --project=slapp-478005

# Enable Cloud Tasks API (should already be enabled)
gcloud services enable cloudtasks.googleapis.com --project=slapp-478005
```

---

### Step 2: Create Response Queue

```bash
gcloud tasks queues create SlappResponses \
  --location=us-central1 \
  --max-dispatches-per-second=10 \
  --max-concurrent-dispatches=20 \
  --max-attempts=3 \
  --project=slapp-478005
```

**Verify queue was created:**
```bash
gcloud tasks queues describe SlappResponses \
  --location=us-central1 \
  --project=slapp-478005
```

---

### Step 3: Configure Environment Variables

```bash
cd "/Users/ram/Enculture Local/Bhargav POCs/Slapp/SlappCloudFunction"

# Copy template
cp env.yaml.template .env.yaml

# Edit with your values
nano .env.yaml  # or use your preferred editor
```

**Fill in `.env.yaml`:**

```yaml
# Gemini API Key
GEMINI_API_KEY: 'AIzaSy...your-actual-key'

# MongoDB Connection (SAME as your backend)
MONGODB_URI: 'mongodb+srv://username:password@cluster.mongodb.net/slapp_database'

# GCP Configuration
GCP_PROJECT_ID: 'slapp-478005'
GCP_LOCATION: 'us-central1'
GCP_TASK_RESPONSES_QUEUE: 'SlappResponses'
```

**Important:**
- Use your **actual Gemini API key**
- Use the **same MongoDB URI** as your backend (database must match!)
- Don't commit `.env.yaml` (already in `.gitignore`)

---

### Step 4: Deploy BOTH Cloud Functions

#### Option A: Deploy Both at Once (Recommended)

```bash
cd "/Users/ram/Enculture Local/Bhargav POCs/Slapp/SlappCloudFunction"

npm run deploy:all
```

This will:
1. Deploy `processEvaluation` function (5-7 minutes)
2. Deploy `saveEvaluationResults` function (5-7 minutes)
3. **Total time: 10-15 minutes**

#### Option B: Deploy Individually

**Deploy Function #1 (Process Evaluation):**
```bash
npm run deploy:process
```

**Wait for completion, then deploy Function #2 (Save Results):**
```bash
npm run deploy:save
```

---

### Step 5: Copy Function URLs

After deployment, you'll see URLs for both functions:

```
Function #1:
https://us-central1-slapp-478005.cloudfunctions.net/processEvaluation

Function #2:
https://us-central1-slapp-478005.cloudfunctions.net/saveEvaluationResults
```

**Copy the first URL!** (processEvaluation)

---

### Step 6: Update Backend Configuration

**Add to Backend `.env` file:**

```env
# Cloud Function URL - where to send evaluation requests
CLOUD_FUNCTION_URL=https://us-central1-slapp-478005.cloudfunctions.net/processEvaluation
```

**Restart Backend:**
```bash
cd Backend
npm run dev
```

---

### Step 7: Test the Complete Flow

#### Test 1: Check Functions are Active

```bash
# Check processEvaluation
gcloud functions describe processEvaluation \
  --region=us-central1 \
  --project=slapp-478005 \
  --gen2

# Check saveEvaluationResults
gcloud functions describe saveEvaluationResults \
  --region=us-central1 \
  --project=slapp-478005 \
  --gen2
```

Both should show: `state: ACTIVE`

#### Test 2: Full Integration Test

**In Frontend:**
1. Login to admin
2. Create an exam
3. Upload question paper and marking scheme
4. Upload at least 1 student answer sheet
5. Click "**Evaluate**" button

**Watch Backend Logs:**
```
📤 Using Google Cloud Tasks for async evaluation
   Using Cloud Function handler: https://us-central1-slapp-478005.cloudfunctions.net/processEvaluation
✅ Evaluation task queued successfully
```

**Watch Function #1 Logs (in new terminal):**
```bash
npm run logs:process
```

Should show:
```
🚀 ============ CLOUD FUNCTION TRIGGERED ============
📦 Payload received: Exam ID: xxx, Students: 5
📤 ============ SENDING TO GEMINI ============
   Processing 5 students in batches of 2
📨 ============ QUEUING RESPONSE ============
   Queue: SlappResponses
   Target Function: https://us-central1-slapp-478005.cloudfunctions.net/saveEvaluationResults
✅ Response queued successfully
```

**Watch Function #2 Logs (in another terminal):**
```bash
npm run logs:save
```

Should show:
```
📨 ============ SAVE RESULTS FUNCTION TRIGGERED ============
📦 Response Data Received: Exam ID: xxx, Students: 5
   🔌 Connecting to MongoDB...
   ✅ Connected to MongoDB: slapp_database
💾 Saving evaluation results to MongoDB...
   ✅ Student 1: 45/50 (90%) - Grade: A+
   ✅ Student 2: 42/50 (84%) - Grade: A
   📊 Updating exam status and token usage...
✅ All results saved successfully to database!
```

---

## 📊 Monitor Functions

### Cloud Console Dashboard

**Function #1:** https://console.cloud.google.com/functions/details/us-central1/processEvaluation?project=slapp-478005

**Function #2:** https://console.cloud.google.com/functions/details/us-central1/saveEvaluationResults?project=slapp-478005

### View Metrics

- Invocations count
- Execution time
- Memory usage
- Error rate
- Active instances

### Real-time Logs

```bash
# Function #1 (Process)
npm run logs:process

# Function #2 (Save)
npm run logs:save

# Follow in real-time
gcloud functions logs read processEvaluation \
  --region=us-central1 \
  --project=slapp-478005 \
  --follow
```

---

## 🔧 Update After Code Changes

**After modifying code:**

```bash
cd "/Users/ram/Enculture Local/Bhargav POCs/Slapp/SlappCloudFunction"

# Commit to GitHub
git add -A
git commit -m "Your changes"
git push origin main

# Redeploy both functions
npm run deploy:all

# Or deploy individually
npm run deploy:process  # Only function #1
npm run deploy:save     # Only function #2
```

---

## 💰 Cost Estimate

### Cloud Functions (Gen 2)

**Function #1 (processEvaluation):**
- Memory: 1GB
- Timeout: 540s (9 min)
- Estimate: ~$3-6/month for 1000 evaluations

**Function #2 (saveEvaluationResults):**
- Memory: 512MB
- Timeout: 300s (5 min)
- Estimate: ~$1-2/month for 1000 evaluations

**Total Cloud Functions: ~$4-8/month**

**Plus:**
- Gemini API costs (as shown in evaluation results)
- Cloud Tasks: FREE (under 1M operations/month)
- MongoDB: Your existing database

---

## 🐛 Troubleshooting

### Error: "API not enabled"

```bash
gcloud services enable cloudfunctions.googleapis.com --project=slapp-478005
gcloud services enable run.googleapis.com --project=slapp-478005
gcloud services enable cloudbuild.googleapis.com --project=slapp-478005
```

### Error: "Permission denied"

```bash
# Authenticate
gcloud auth login

# Set project
gcloud config set project slapp-478005

# Grant yourself owner role (if needed)
gcloud projects add-iam-policy-binding slapp-478005 \
  --member="user:your-email@gmail.com" \
  --role="roles/owner"
```

### Error: "MongoDB connection failed"

- Verify `MONGODB_URI` is correct in `.env.yaml`
- Check MongoDB Atlas allows connections from `0.0.0.0/0` (all IPs)
- Or whitelist Google Cloud IPs

### Error: "Queue not found"

```bash
# List all queues
gcloud tasks queues list --location=us-central1 --project=slapp-478005

# Create if missing
gcloud tasks queues create SlappResponses --location=us-central1 --project=slapp-478005
```

### Error: "Function timeout"

Increase timeout:
```bash
# For processEvaluation
--timeout=540s  # 9 minutes

# For saveEvaluationResults
--timeout=300s  # 5 minutes
```

---

## 📋 Deployment Checklist

- [ ] All required APIs enabled
- [ ] `SlappResponses` queue created
- [ ] `.env.yaml` file created with correct values
- [ ] MongoDB URI configured (same database as backend)
- [ ] Gemini API key added
- [ ] Function #1 deployed (processEvaluation)
- [ ] Function #2 deployed (saveEvaluationResults)
- [ ] Both functions show ACTIVE status
- [ ] Function URLs copied
- [ ] Backend `.env` updated with CLOUD_FUNCTION_URL
- [ ] Backend restarted
- [ ] Test evaluation completed successfully
- [ ] Results saved to database
- [ ] Frontend shows evaluation results

---

## ✨ Success Criteria

Your deployment is successful when:

1. ✅ Both functions show "ACTIVE" state
2. ✅ Test evaluation completes without errors
3. ✅ Function #1 logs show "Response queued successfully"
4. ✅ Function #2 logs show "All results saved successfully"
5. ✅ Evaluation results appear in MongoDB
6. ✅ Frontend displays results correctly

---

## 🎉 Benefits of This Architecture

**Serverless:**
- ✅ No backend API calls needed for processing
- ✅ Functions scale automatically
- ✅ Pay only for what you use

**Reliable:**
- ✅ Automatic retries on failure
- ✅ Queues buffer requests
- ✅ Functions are stateless

**Fast:**
- ✅ Parallel processing
- ✅ No API roundtrips
- ✅ Direct database access

**Cost-Effective:**
- ✅ ~$4-8/month for Cloud Functions
- ✅ Free tier covers most usage
- ✅ Only Gemini API costs remain

---

## 🚀 Ready to Deploy?

**Run this single command:**

```bash
cd "/Users/ram/Enculture Local/Bhargav POCs/Slapp/SlappCloudFunction"
npm run deploy:all
```

**Wait 10-15 minutes** for both functions to deploy, then test! 🎊

---

## 📞 Need Help?

Check logs first:
```bash
npm run logs:process  # Function #1
npm run logs:save     # Function #2
```

See errors in Cloud Console:
- https://console.cloud.google.com/functions?project=slapp-478005

