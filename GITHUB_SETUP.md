# GitHub Repository Setup

## 🎯 Create GitHub Repository

### Step 1: Create Repository on GitHub

1. Go to: https://github.com/LiveSloka
2. Click "**New**" (green button) or "**+**" → "**New repository**"
3. Fill in:
   - **Repository name**: `slapp-cloud-function`
   - **Description**: `Google Cloud Function for Slapp evaluation processing with Gemini AI`
   - **Visibility**: Choose Public or Private
   - ✅ **DO NOT** initialize with README, .gitignore, or license (we already have them)
4. Click "**Create repository**"

---

### Step 2: Push to GitHub

After creating the repository, run these commands:

```bash
cd "/Users/ram/Enculture Local/Bhargav POCs/Slapp/SlappCloudFunction"

# Add remote (replace with your actual repo URL)
git remote add origin https://YOUR_TOKEN@github.com/livekumon/slapp-cloud-functions.git

# Push to GitHub
git push -u origin main
```

**Alternative (if you want SSH):**
```bash
git remote add origin git@github.com:livekumon/slapp-cloud-functions.git
git push -u origin main
```

---

### Step 3: Verify

Go to: https://github.com/livekumon/slapp-cloud-functions

You should see:
- ✅ README.md
- ✅ index.js
- ✅ package.json
- ✅ DEPLOYMENT_GUIDE.md
- ✅ env.yaml.template
- ✅ .gitignore

---

## 📋 Repository Structure

```
slapp-cloud-function/
├── .gitignore              # Git ignore rules
├── DEPLOYMENT_GUIDE.md     # Complete deployment instructions
├── GITHUB_SETUP.md         # This file
├── README.md               # Project overview
├── env.yaml.template       # Environment variables template
├── index.js                # Main Cloud Function code
└── package.json            # Dependencies
```

---

## 🔗 Related Repositories

| Repository | URL |
|------------|-----|
| **Backend** | https://github.com/LiveSloka/ajas_backend |
| **Frontend** | https://github.com/LiveSloka/ajas_frontend |
| **Cloud Function** | https://github.com/LiveSloka/slapp-cloud-function |

---

## 🔐 Important Security Notes

### Files NOT in Git (Ignored)

These files are in `.gitignore` and should **NEVER** be committed:

- ✅ `.env.yaml` - Contains sensitive API keys
- ✅ `*.yaml` (except `.template` files)
- ✅ `*.json` (except `package.json`)
- ✅ `node_modules/`

### Before Pushing

Always check you're not committing sensitive data:

```bash
# Check what will be committed
git status

# View changes
git diff

# If you see .env.yaml or credentials, DON'T PUSH!
```

---

## 🚀 Quick Commands Reference

### Clone Repository (for others)

```bash
git clone https://github.com/LiveSloka/slapp-cloud-function.git
cd slapp-cloud-function
```

### Update Repository

```bash
# Make changes
git add -A
git commit -m "Your commit message"
git push origin main
```

### Pull Latest Changes

```bash
git pull origin main
```

---

## ✅ Setup Checklist

After pushing to GitHub:

- [ ] Repository created on GitHub
- [ ] Code pushed successfully
- [ ] README.md displays correctly
- [ ] .gitignore is working (no .env.yaml in repo)
- [ ] Repository is accessible
- [ ] Update Backend docs with Cloud Function repo URL

---

## 🆘 Troubleshooting

### Error: "remote origin already exists"

```bash
git remote remove origin
git remote add origin https://...
```

### Error: "Permission denied"

Make sure you're using the correct GitHub token or SSH key:

```bash
# Using token
git remote set-url origin https://YOUR_TOKEN@github.com/livekumon/slapp-cloud-functions.git

# Using SSH
git remote set-url origin git@github.com:livekumon/slapp-cloud-functions.git
```

### Error: "Updates were rejected"

```bash
# Force push (use with caution!)
git push -f origin main
```

---

**Ready to push?** Follow Step 2 above! 🚀

