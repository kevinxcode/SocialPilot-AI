# MASTER PROJECT PROMPT
# SOCIALPILOT AI – MULTI-PLATFORM SOCIAL MEDIA AUTOMATION

## 1. ROLE & PROJECT OBJECTIVE

Act as a Principal Software Architect, Senior Chrome Extension Developer, Full-Stack Engineer, AI Engineer, Meta API Integration Specialist, and Senior UI/UX Designer.

Build a production-ready Chrome Extension called:

**SocialPilot AI**

An AI-powered social media management and automatic publishing platform for:

1. Threads
2. Facebook Pages

The platform must integrate three AI providers:

1. OpenRouter AI
2. Ollama Local AI
3. NVIDIA AI / NVIDIA NIM

The application should help users research, generate, optimize, organize, schedule, and automatically publish social media content.

This must be a real, functional application, not just a UI prototype.

Primary use case: automated content marketing for CuciQu and CuciQu Pro.

Brand reference:
- Website: https://cuciqu.com/
- Affiliate: https://app.cuciqu.com/
- Industry: Laundry Management Software
- Target audience: Laundry business owners, laundry entrepreneurs, and multi-outlet laundry operators.

---

# 2. DEVELOPMENT PRINCIPLES

Before implementation:

1. Inspect the existing workspace.
2. Check available files and existing project structure.
3. Reuse existing infrastructure if appropriate.
4. Do not overwrite existing work without understanding it.
5. Create an implementation plan.
6. Build incrementally.
7. Test every major feature.
8. Fix errors before moving to the next phase.

Do not stop after creating the dashboard design.

Every button, menu, setting, and interaction must have a real implementation or an explicitly documented unavailable state.

Never use fake publishing success, fabricated analytics, or simulated API responses as production functionality.

---

# 3. TECHNOLOGY STACK

Use:

### Frontend
- React
- TypeScript
- Vite
- Tailwind CSS
- Shadcn/UI
- Lucide Icons

### Chrome Extension
- Chrome Extension Manifest V3
- Chrome Storage API
- Chrome Alarms API
- Chrome Notifications API
- Chrome Identity API where appropriate
- Service Worker
- Content Security Policy

### Data
- IndexedDB
- Chrome Storage
- Optional PostgreSQL backend

### AI
- OpenRouter API
- Ollama API
- NVIDIA API Catalog / NVIDIA NIM

### Social Media
- Meta Threads API
- Meta Graph API

Architecture must be modular, maintainable, and scalable.

---

# 4. APPLICATION ARCHITECTURE

Separate the application into these modules:

- Dashboard
- AI Content Studio
- AI Provider Manager
- Content Planner
- Content Calendar
- Publishing Scheduler
- Media Library
- Social Account Manager
- Brand Knowledge Base
- Analytics
- Posting History
- Settings
- Background Publishing Service

Recommended architecture:

src/
  app/
  components/
  pages/
  layouts/
  hooks/
  services/
    ai/
      providers/
        OpenRouterProvider.ts
        OllamaProvider.ts
        NvidiaProvider.ts
      AIRouter.ts
      ModelRegistry.ts
      CostGuard.ts
    social/
      ThreadsService.ts
      FacebookService.ts
      MetaOAuthService.ts
    publishing/
      Scheduler.ts
      PublishingQueue.ts
      RetryManager.ts
    media/
    storage/
  background/
    service-worker.ts
  utils/
  types/
  config/

Use clear TypeScript interfaces and strict typing.

---

# 5. AI MULTI-PROVIDER SYSTEM

Implement a unified AI provider architecture.

## A. OpenRouter

API:
https://openrouter.ai/api/v1/chat/completions

Features:
- API key configuration.
- Dynamic model discovery.
- Free model filtering.
- Paid model filtering.
- Vision model filtering.
- Model selection.
- Temperature.
- Max tokens.
- Streaming responses.
- Connection testing.
- Error handling.

Official:
https://openrouter.ai/docs

## B. Ollama Local AI

Default endpoint:
http://localhost:11434

Official:
https://ollama.com/

Features:
- Connect to local Ollama.
- Check service availability.
- Retrieve installed models.
- Download model instructions.
- Select installed model.
- Generate content.
- Rewrite content.
- Generate hashtags.
- Generate ideas.
- Analyze content.
- Streaming responses.
- Vision support where the selected model supports it.

Use Ollama APIs according to official documentation.

Never assume a model is installed.

Provide configurable host and port.

Provide connection troubleshooting for:
- Ollama not running.
- CORS errors.
- Missing model.
- Timeout.
- Unsupported model capabilities.

Ollama must support local inference without cloud API charges. Hardware and electricity costs are not zero.

## C. NVIDIA AI

Official:
https://build.nvidia.com/

Integrate NVIDIA AI Catalog / NIM.

Features:
- API key configuration.
- Model selection.
- Dynamic model discovery where available.
- Connection testing.
- Text generation.
- Content rewriting.
- Hashtag generation.
- Marketing ideas.
- Streaming where supported.

Use the correct endpoint and request schema for each model.

Do not assume every NVIDIA model uses an identical API format.

NVIDIA free access and credits may be subject to changing terms and limits.

## D. AI PROVIDER MANAGER

Create a dedicated settings page.

Display three provider cards:

- OpenRouter
- Ollama
- NVIDIA

Each card must include:
- Provider name.
- Connection status.
- API configuration.
- Selected model.
- Test connection.
- Enable / Disable.
- Model capability information.
- Last successful connection.

Support:

1. Manual Mode
2. Automatic Mode
3. Free Only Mode
4. Offline Mode

### Smart AI Router

Automatic provider priority:

1. Ollama
2. NVIDIA
3. OpenRouter

The priority must be configurable.

If a provider fails, automatically try the next eligible provider.

Important rules:

- Never switch to a paid model without user authorization.
- Free Only Mode must block paid models.
- Offline Mode must only use Ollama.
- Do not silently send private content to another provider.
- Respect model capabilities.
- Do not route image analysis to a text-only model.

## E. AI COST GUARD

Create cost management.

Track:
- Requests.
- Provider usage.
- Model usage.
- Estimated costs.
- Failed requests.
- Average response time.

Display Ollama API cost as Rp0 while clarifying that local hardware and electricity have costs.

Only display cloud pricing when reliable pricing data is available.

---

# 6. AI CONTENT STUDIO

This is the primary application feature.

Create a professional content generation interface.

Input:

- Brand.
- Website.
- Topic.
- Content objective.
- Target audience.
- Language.
- Platform.
- Content type.
- Tone.
- CTA.
- Hashtag preferences.
- Media attachment.

Content types:

1. Educational.
2. Promotional.
3. Storytelling.
4. Industry News.
5. Tips & Tricks.
6. Product Updates.
7. Customer Engagement.
8. Industry Research.
9. Problem & Solution.
10. Question & Discussion.
11. Product Comparison.
12. Brand Awareness.

AI output:

- Content title.
- Hook.
- Caption.
- Main body.
- CTA.
- Hashtags.
- Suggested posting time.
- Image generation prompt.
- Platform-specific formatting.

Generate at least three variations per request.

Actions:
- Generate.
- Regenerate.
- Rewrite.
- Shorten.
- Expand.
- Improve Hook.
- Change Tone.
- Generate Hashtags.
- Copy.
- Save Draft.
- Schedule.
- Publish Now.

Support Indonesian and English.

Content should be natural, engaging, non-repetitive, and appropriate for each platform.

---

# 7. AI CONTENT RESEARCH

Build an AI-powered content research module.

Features:

- Generate trending topic ideas.
- Discover industry discussion themes.
- Create educational topic lists.
- Generate competitor content analysis from user-provided public URLs or accessible sources.
- Identify audience pain points.
- Create weekly marketing plans.
- Generate content calendars.
- Suggest engagement questions.

Do not claim real-time trends without a real research source.

Keep research source references when available.

Allow users to save research as content ideas.

---

# 8. BRAND KNOWLEDGE BASE

Create reusable brand profiles.

Initial profile:

Brand: CuciQu Pro

Website:
https://cuciqu.com/

Affiliate:
https://app.cuciqu.com/

Industry:
Laundry Management Software.

Target audience:
- Laundry owners.
- Laundry entrepreneurs.
- Multi-outlet laundry businesses.
- Laundry operators.

Positioning:
A mobile cashier and laundry management application that helps laundry businesses manage transactions, orders, employees, and operations.

Allow users to configure:

- Brand description.
- Product information.
- Features.
- Pricing.
- Target audience.
- Brand voice.
- Marketing strategy.
- CTA.
- Website URLs.
- Prohibited claims.

AI must use the knowledge base when creating content.

Never invent prices, product features, statistics, or testimonials.

Support multiple brands and brand switching.

---

# 9. MEDIA LIBRARY

Build a media manager.

Initial marketing directory:

C:\locale\intelij\londy-artifacts-marketing\app-marketing

Allow users to import this folder using a directory picker.

Do not assume a Chrome Extension has unrestricted access to local folders.

Features:

- Import multiple images.
- Import videos.
- Preview media.
- Search.
- Filter.
- Tags.
- Categories.
- Image dimensions.
- File information.
- Used / unused status.
- Assign media to posts.
- Track publishing history.

Support drag and drop.

Use IndexedDB or another appropriate persistent storage mechanism.

---

# 10. THREADS INTEGRATION

Use the official Meta Threads API.

Documentation:
https://developers.facebook.com/docs/threads/

Features:

- Connect Threads account.
- OAuth authentication.
- Retrieve account information.
- Text publishing.
- Image publishing.
- Video publishing.
- Carousel publishing when supported.
- Store published post ID.
- Check publishing status.
- Publishing history.

Implement the correct Threads media container creation and publishing workflow.

Respect API requirements, supported media types, rate limits, and permissions.

Do not use browser scraping or unofficial posting endpoints.

---

# 11. FACEBOOK PAGES INTEGRATION

Use official Meta Graph API.

Documentation:
https://developers.facebook.com/docs/graph-api/

Features:

- Connect Meta account.
- OAuth.
- Retrieve managed Facebook Pages.
- Select a Page.
- Publish text.
- Publish images.
- Publish videos.
- Retrieve post information.
- Track publishing status.

Implement the permissions required for Page management.

Document Meta App Review requirements.

Do not assume every connected Facebook account has publishing permissions.

---

# 12. CONTENT CALENDAR & SCHEDULER

Create a full content scheduling system.

Features:

- Calendar.
- Daily view.
- Weekly view.
- Monthly view.
- List view.
- Drag and drop scheduling.
- Edit schedule.
- Duplicate content.
- Delete scheduled content.
- Filter by platform.
- Filter by account.
- Filter by status.

Posting status:

- Draft.
- Scheduled.
- Processing.
- Published.
- Failed.
- Cancelled.

Scheduling configuration:

- Date.
- Time.
- Timezone.
- Platform.
- Social account.
- Caption.
- Media.
- AI provider.

Use Asia/Jakarta as the initial timezone.

### Scheduler architecture

Use Chrome Alarms API for local scheduling.

Use persistent storage for publishing queue.

Implement:
- Duplicate prevention.
- Retry mechanism.
- Publishing locks.
- Error logging.
- API rate-limit handling.
- Recovery after browser restart.
- Notifications.

IMPORTANT:

Chrome Extension cannot guarantee background publishing while Chrome is completely closed or the device is offline.

Therefore, create an optional backend scheduler architecture for reliable 24/7 publishing.

The extension should be able to communicate with this backend.

Do not claim 24/7 scheduling until backend execution is implemented and tested.

---

# 13. POSTING WORKFLOW

Implement this publishing workflow:

1. User generates content.
2. User reviews AI output.
3. User selects platform.
4. User selects account.
5. User selects media.
6. User chooses publish now or schedule.
7. System validates content.
8. Publishing queue processes the post.
9. Social API publishes the post.
10. System retrieves the publishing result.
11. Save post ID and status.
12. Display success or failure.

Never mark a post Published before the platform confirms successful publishing.

If an API request times out after submission, reconcile the publishing state before retrying to avoid duplicate posts.

---

# 14. DASHBOARD & ANALYTICS

Dashboard:

- Total posts.
- Published posts.
- Scheduled posts.
- Failed posts.
- Connected accounts.
- AI provider status.
- Upcoming posts.
- Recent activity.
- Quick AI generation.

Analytics:

- Posts per platform.
- Publishing frequency.
- Publishing success rate.
- Content history.
- Provider usage.
- Estimated AI costs.

Do not fabricate engagement metrics.

Show N/A when data is unavailable through the official APIs.

---

# 15. USER INTERFACE / UX

Design direction:

**Clean Modern Compact SaaS Dashboard**

Visual style:
- Premium.
- Minimal.
- Modern.
- Professional.
- Compact.
- Responsive.
- Excellent typography.
- Consistent spacing.
- Light and dark themes.

Sidebar:

1. Dashboard
2. AI Content Studio
3. Content Research
4. Content Calendar
5. Scheduled Posts
6. Media Library
7. Social Accounts
8. Analytics
9. Brand Knowledge
10. AI Providers
11. Settings

Create both:
- Full dashboard page.
- Compact Chrome extension popup.

Use reusable components.

Avoid cluttered layouts, excessive gradients, oversized cards, and unnecessary animations.

---

# 16. SECURITY

Implement:

- OAuth state validation.
- PKCE where supported.
- Token expiration handling.
- Secure token management.
- API key protection.
- Minimum permissions.
- Strict input validation.
- Content Security Policy.
- No hardcoded secrets.
- No credential logging.
- Request timeouts.
- Rate-limit handling.

For multi-user production deployment, move sensitive OAuth tokens and scheduled publishing to a secure backend.

Never store social media passwords.

Never bypass Meta authentication or access restrictions.

---

# 17. DATABASE & STORAGE DESIGN

Design persistent schemas for:

- Users.
- Brands.
- BrandKnowledge.
- AIProviders.
- AIModels.
- SocialAccounts.
- Media.
- ContentIdeas.
- ContentDrafts.
- ScheduledPosts.
- PublishedPosts.
- PublishingQueue.
- AIUsage.
- ActivityLogs.
- ApplicationSettings.

Use appropriate indexes and relationships.

Provide migrations if a backend database is implemented.

Support export and import of content data.

---

# 18. TESTING

Perform real testing.

### AI
- OpenRouter connection.
- Ollama connection.
- NVIDIA connection.
- Model discovery.
- Content generation.
- Multiple variations.
- Automatic fallback.
- Free Only Mode.
- Offline Mode.
- Cost Guard.

### Social Media
- OAuth.
- Threads account connection.
- Facebook Page retrieval.
- Threads publishing.
- Facebook publishing.
- Image upload.
- Video upload.
- API errors.
- Token expiration.

### Scheduler
- Schedule creation.
- Scheduled publishing.
- Browser restart.
- Duplicate prevention.
- Failed publishing.
- Retry handling.
- Timezone handling.

### Extension
- Manifest validation.
- Build.
- Load unpacked in Chrome.
- Popup.
- Dashboard.
- Service worker.
- Storage persistence.
- Permission validation.

Create automated tests wherever possible.

Do not use mocked responses as proof of successful real-world publishing.

---

# 19. IMPLEMENTATION PHASES

Execute the project in these phases.

PHASE 1 – FOUNDATION
- Inspect workspace.
- Setup project.
- Setup Manifest V3.
- Setup React and TypeScript.
- Build dashboard.
- Build settings.
- Implement persistent storage.

PHASE 2 – AI ENGINE
- OpenRouter.
- Ollama.
- NVIDIA.
- Provider Manager.
- Model Registry.
- Smart AI Router.
- Cost Guard.

PHASE 3 – CONTENT SYSTEM
- Brand Knowledge Base.
- AI Content Studio.
- Content Research.
- Media Library.
- Content Drafts.

PHASE 4 – SOCIAL INTEGRATION
- Meta OAuth.
- Threads API.
- Facebook Graph API.
- Real publishing.

PHASE 5 – AUTOMATION
- Content Calendar.
- Publishing Queue.
- Scheduler.
- Retry Manager.
- Notifications.

PHASE 6 – ANALYTICS
- Dashboard metrics.
- AI usage.
- Publishing history.
- Logs.

PHASE 7 – FINALIZATION
- Security audit.
- Performance optimization.
- Integration tests.
- Production build.
- Installation documentation.

---

# 20. FINAL DELIVERABLES

Provide:

1. Complete source code.
2. Working Chrome Extension.
3. Manifest V3 configuration.
4. Installation instructions.
5. OpenRouter configuration guide.
6. Ollama installation and model setup guide.
7. NVIDIA API configuration guide.
8. Meta Developer App configuration guide.
9. Threads OAuth documentation.
10. Facebook Page integration guide.
11. Database schema.
12. Testing report.
13. Known limitations.
14. Production deployment guide.

Create a README with clear step-by-step instructions.

---

# 21. EXECUTION RULES

IMPORTANT DEVELOPMENT INSTRUCTIONS:

- Do not only provide code snippets.
- Actually create and modify project files.
- Run npm install.
- Run the development server.
- Run TypeScript checks.
- Run lint.
- Run production build.
- Fix all build errors.
- Test the extension in Chrome.
- Verify each feature before marking it complete.

Do not implement everything as a single monolithic component.

Do not skip error handling.

Do not use fake API integrations.

Do not fabricate success responses.

Do not silently use paid AI models.

If credentials or Meta approval are missing, complete all possible implementation work and clearly document what requires external configuration.

After each phase, provide:
- Files created or modified.
- Features implemented.
- Tests executed.
- Test results.
- Remaining issues.

Start by inspecting the current workspace and implementing Phase 1 immediately.

**FINAL PRIORITY:**

1. Multi-provider AI (OpenRouter + Ollama + NVIDIA).
2. AI Content Generator.
3. Media Library.
4. Threads Auto Publishing.
5. Facebook Pages Auto Publishing.
6. Content Scheduler.
7. Content Calendar.
8. Analytics.

The final result must be a functional, extensible, professional Chrome Extension that can evolve into a standalone SaaS product.