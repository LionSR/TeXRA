# Product Requirements Document (PRD)
# TeXRA Web Application
## From VS Code Extension to Overleaf-like Web Experience

---

## 1. Executive Summary

### 1.1 Product Vision
Transform TeXRA from a VS Code extension into a modern, cloud-based LaTeX editing platform that combines the power of AI-assisted writing with real-time collaboration and PDF preview capabilities, similar to Overleaf but enhanced with advanced LLM features.

### 1.2 Target Audience
- Academic researchers and students
- Scientific paper authors
- Technical documentation writers
- Teams collaborating on LaTeX documents
- Individual users seeking AI-enhanced LaTeX editing

### 1.3 Key Value Proposition
- **AI-Powered Writing Assistant**: Integrated LLM agents for grammar correction, style polishing, figure generation, and more
- **Real-time Collaboration**: Multiple users editing simultaneously with conflict-free synchronization
- **Live PDF Preview**: Instant compilation and side-by-side preview
- **Zero Setup**: No local LaTeX installation required
- **Cross-Platform**: Works on any device with a web browser

---

## 2. Recommended Technology Stack

### 2.1 Frontend Architecture

#### **Primary Framework: Next.js 15 with App Router**
- **Rationale**: 
  - Server-side rendering for better SEO and initial load performance
  - Built-in API routes for backend integration
  - Excellent TypeScript support (maintaining consistency with current codebase)
  - React Server Components for optimal performance
  - Incremental Static Regeneration for marketing pages

#### **UI Component Library: shadcn/ui + Radix UI**
- **Rationale**:
  - Modern, accessible components out of the box
  - Highly customizable with Tailwind CSS
  - Lightweight and performant
  - No vendor lock-in (components are copied to your codebase)
  - Perfect for startup iteration speed

#### **Styling: Tailwind CSS v4**
- **Rationale**:
  - Utility-first approach for rapid development
  - Excellent performance with JIT compilation
  - Easy to maintain design consistency
  - Great for responsive design

#### **State Management: Zustand + TanStack Query**
- **Rationale**:
  - Zustand: Simple, lightweight state management (8kb)
  - TanStack Query: Powerful server state synchronization
  - Much simpler than Redux while being equally powerful
  - Better TypeScript support

#### **Editor Components:**
- **Monaco Editor** (same as VS Code)
  - Already familiar from VS Code extension
  - Excellent LaTeX syntax highlighting
  - Extensible with custom languages
- **PDF.js** for PDF rendering
  - Mozilla's battle-tested PDF viewer
  - Supports annotations and text selection
  - Can be customized for LaTeX-specific features

#### **Real-time Collaboration: Y.js + WebRTC/WebSocket**
- **Rationale**:
  - Y.js: CRDT-based collaborative editing
  - Works offline and syncs when reconnected
  - Proven in production (used by many collaborative editors)
  - Can integrate with Monaco Editor

### 2.2 Backend Architecture

#### **Runtime & Framework: Node.js with Fastify**
- **Rationale**:
  - Fastify: 20% faster than Express, better for WebSocket
  - Excellent TypeScript support
  - Plugin architecture for modularity
  - Built-in schema validation
  - Lower overhead than Express

#### **API Architecture: tRPC + GraphQL (Hybrid)**
- **tRPC** for internal APIs:
  - End-to-end type safety with TypeScript
  - No code generation needed
  - Perfect for rapid iteration
- **GraphQL** for public API (future):
  - Better for external developers
  - Self-documenting
  - Flexible querying

#### **Database: PostgreSQL with Prisma ORM**
- **PostgreSQL**:
  - Robust, battle-tested relational database
  - Excellent for complex queries
  - JSONB support for flexible data
  - Full-text search capabilities
- **Prisma**:
  - Type-safe database access
  - Automatic migrations
  - Great developer experience

#### **Caching & Session: Redis**
- **Rationale**:
  - Fast in-memory caching
  - Session management
  - Pub/sub for real-time features
  - Queue management for background jobs

#### **File Storage: S3-compatible (AWS S3 / Cloudflare R2)**
- **Rationale**:
  - Cloudflare R2: No egress fees (huge cost savings)
  - S3 compatibility allows easy migration
  - CDN integration for fast file delivery
  - Automatic backups and versioning

#### **LaTeX Compilation: Docker-based TeXLive**
- **Rationale**:
  - Isolated compilation environment
  - Consistent across all users
  - Security through containerization
  - Easy to scale horizontally

### 2.3 Infrastructure & DevOps

#### **Hosting Platform: Vercel (Frontend) + Railway/Fly.io (Backend)**
- **Vercel** for frontend:
  - Optimized for Next.js
  - Automatic deployments
  - Global CDN
  - Excellent DX for small teams
- **Railway** or **Fly.io** for backend:
  - Simple deployment from GitHub
  - Built-in database hosting
  - WebSocket support
  - Cost-effective for startups

#### **Container Orchestration: Docker Compose → Kubernetes (later)**
- Start with Docker Compose for simplicity
- Migrate to K8s when scale demands it

#### **CI/CD: GitHub Actions**
- **Rationale**:
  - Integrated with GitHub
  - Free for public repos
  - Extensive marketplace
  - Matrix builds for testing

#### **Monitoring & Observability**
- **Sentry** for error tracking
- **PostHog** for product analytics
- **Datadog** or **New Relic** for APM (when scaled)
- **Prometheus + Grafana** for metrics (self-hosted option)

### 2.4 AI/LLM Integration

#### **LLM Gateway: LiteLLM or Custom Proxy**
- **Rationale**:
  - Unified interface for multiple LLM providers
  - Fallback and load balancing
  - Cost tracking and rate limiting
  - Response caching

#### **Supported Providers** (maintain current support):
- OpenAI (GPT-4, GPT-4o)
- Anthropic (Claude 3.5)
- Google (Gemini)
- Open-source models via Replicate/Together

#### **Vector Database: Pinecone or Qdrant**
- For semantic search in documents
- RAG (Retrieval Augmented Generation) capabilities
- Citation and reference management

---

## 3. Core Features & Implementation

### 3.1 Editor Experience

#### **Split-Pane Interface**
```
┌─────────────────────────────────────────┐
│  Toolbar (File, Edit, AI Actions)       │
├──────────────┬──────────────────────────┤
│              │                          │
│  File Tree   │  LaTeX Editor  │  PDF    │
│              │                │ Preview │
│              │                │         │
└──────────────┴────────────────┴─────────┘
```

#### **Key Features:**
1. **Syntax Highlighting**: LaTeX-aware with custom themes
2. **Auto-completion**: Commands, references, citations
3. **Error Highlighting**: Real-time LaTeX error detection
4. **Multi-cursor Editing**: VS Code-like experience
5. **Find & Replace**: With regex support
6. **Code Folding**: Section-based folding

### 3.2 AI Agent Integration

#### **Agent Panel Design:**
- Floating sidebar or modal interface
- Quick access via keyboard shortcuts (Cmd/Ctrl + K)
- Context-aware suggestions based on cursor position

#### **Agent Execution Flow:**
1. User selects text or positions cursor
2. Opens agent panel
3. Selects agent type (correct, polish, draw, etc.)
4. Provides additional instructions
5. Reviews AI suggestions in diff view
6. Accepts/rejects changes

### 3.3 Real-time Collaboration

#### **Features:**
1. **Presence Indicators**: See where others are editing
2. **Collaborative Cursors**: Color-coded cursors
3. **Comments & Annotations**: Inline discussions
4. **Change Tracking**: Git-like blame view
5. **Conflict Resolution**: Automatic CRDT-based merging

### 3.4 PDF Compilation & Preview

#### **Compilation Pipeline:**
```
User Edit → Debounced Trigger → Queue Job → Docker Container → PDF Output → CDN
```

#### **Features:**
1. **Incremental Compilation**: Only recompile changed parts
2. **Error Reporting**: Clear error messages with line numbers
3. **SyncTeX**: Click-to-jump between source and PDF
4. **PDF Annotations**: Highlight and comment on PDF
5. **Export Options**: Download PDF, LaTeX source, or ZIP

### 3.5 Project Management

#### **Features:**
1. **Template Gallery**: Pre-built templates for papers, thesis, etc.
2. **Version Control**: Automatic snapshots and named versions
3. **Project Sharing**: Public/private with granular permissions
4. **Import/Export**: GitHub integration, Overleaf import
5. **Build Configurations**: Custom compilation settings

---

## 4. Database Schema (Simplified)

```sql
-- Core Entities
Users (id, email, name, created_at, subscription_tier)
Projects (id, owner_id, name, created_at, is_public)
Files (id, project_id, path, content, version)
Collaborators (project_id, user_id, permission_level)

-- AI Features
AgentExecutions (id, user_id, agent_type, input, output, tokens_used)
CustomPrompts (id, user_id, agent_type, prompt_template)

-- Collaboration
Comments (id, file_id, user_id, line_number, content)
Versions (id, project_id, tag, snapshot_data, created_at)

-- Compilation
CompilationJobs (id, project_id, status, output_url, logs)
```

---

## 5. Security Considerations

### 5.1 Authentication & Authorization
- **Auth Provider**: Auth0 or Clerk (managed service)
- **Session Management**: JWT with refresh tokens
- **Role-Based Access Control**: Owner, Editor, Viewer
- **2FA Support**: TOTP-based

### 5.2 Data Security
- **Encryption at Rest**: AES-256 for stored files
- **Encryption in Transit**: TLS 1.3 minimum
- **Input Sanitization**: Prevent LaTeX injection attacks
- **Rate Limiting**: Per-user and per-IP
- **CORS Configuration**: Strict origin validation

### 5.3 Compilation Security
- **Sandboxed Execution**: Docker containers with limited resources
- **No Network Access**: Compilation containers isolated
- **Resource Limits**: CPU, memory, and time limits
- **File System Isolation**: Read-only base image

---

## 6. Performance Requirements

### 6.1 Target Metrics
- **Page Load**: < 2s for editor interface
- **Compilation Time**: < 10s for typical document
- **Typing Latency**: < 50ms for character appearance
- **Collaboration Sync**: < 200ms for cursor updates
- **AI Response**: < 5s for typical agent execution

### 6.2 Scalability Targets
- **Concurrent Users**: 10,000 initial, 100,000 within year 1
- **Storage**: 10GB per user average
- **API Requests**: 1000 req/s sustained
- **WebSocket Connections**: 50,000 concurrent

---

## 7. Migration Strategy

### Phase 1: MVP (Months 1-3)
1. **Core Editor**: Monaco-based LaTeX editor
2. **Basic Compilation**: Simple PDF generation
3. **User Authentication**: Basic auth flow
4. **File Management**: Create, save, delete projects
5. **Single AI Agent**: Start with "polish" agent

### Phase 2: Collaboration (Months 4-5)
1. **Real-time Sync**: Y.js integration
2. **User Presence**: Cursor and selection sharing
3. **Comments**: Basic annotation system
4. **Sharing**: Project sharing with permissions

### Phase 3: Full AI Suite (Months 6-7)
1. **All Agents**: Port all VS Code extension agents
2. **Custom Prompts**: User-defined templates
3. **Batch Processing**: Multiple file operations
4. **AI History**: Track and revert AI changes

### Phase 4: Advanced Features (Months 8-12)
1. **Git Integration**: GitHub/GitLab sync
2. **Citation Management**: BibTeX integration
3. **Template Marketplace**: Community templates
4. **API Access**: Public API for developers
5. **Offline Mode**: PWA with sync

---

## 8. Monetization Strategy

### 8.1 Pricing Tiers

#### **Free Tier**
- 3 private projects
- 100 AI agent executions/month
- Basic compilation (queue priority)
- 1GB storage

#### **Pro Tier ($12/month)**
- Unlimited private projects
- 1000 AI agent executions/month
- Priority compilation
- 20GB storage
- Collaboration features
- Version history (30 days)

#### **Team Tier ($25/user/month)**
- Everything in Pro
- Unlimited AI executions
- 100GB storage per user
- Admin controls
- SSO integration
- Priority support

#### **Enterprise (Custom)**
- Self-hosted option
- Custom AI models
- SLA guarantees
- Dedicated support

### 8.2 Additional Revenue Streams
- Template marketplace (30% commission)
- AI token packages for power users
- White-label solutions for universities
- Professional services (training, customization)

---

## 9. Success Metrics & KPIs

### 9.1 User Metrics
- **MAU (Monthly Active Users)**: Target 50K in year 1
- **DAU/MAU Ratio**: Target > 40%
- **User Retention**: 60% at 3 months
- **NPS Score**: > 50

### 9.2 Business Metrics
- **Conversion Rate**: Free to Paid > 5%
- **MRR Growth**: 20% month-over-month
- **Churn Rate**: < 5% monthly
- **CAC Payback**: < 12 months

### 9.3 Technical Metrics
- **Uptime**: 99.9% SLA
- **Error Rate**: < 0.1%
- **API Response Time**: p95 < 500ms
- **Compilation Success Rate**: > 95%

---

## 10. Risk Analysis & Mitigation

### 10.1 Technical Risks
| Risk | Impact | Mitigation |
|------|--------|------------|
| LaTeX compilation complexity | High | Use proven TeXLive, implement fallbacks |
| Real-time sync conflicts | Medium | CRDT (Y.js) handles most cases automatically |
| AI API costs | High | Implement caching, rate limiting, tiered pricing |
| Scaling WebSocket connections | Medium | Use Redis pub/sub, horizontal scaling |

### 10.2 Business Risks
| Risk | Impact | Mitigation |
|------|--------|------------|
| Overleaf market dominance | High | Differentiate with AI features, better UX |
| AI provider dependency | Medium | Multi-provider support, fallback options |
| User data loss | Critical | Regular backups, version control, redundancy |
| Slow adoption | High | Free tier, university partnerships, content marketing |

---

## 11. Development Team Structure

### 11.1 Initial Team (6-8 people)
1. **Technical Lead/Architect** (1)
   - System design, code reviews, technical decisions

2. **Full-Stack Engineers** (3-4)
   - Feature development across stack
   - Focus areas: Editor, Collaboration, AI Integration

3. **DevOps Engineer** (1)
   - Infrastructure, CI/CD, monitoring
   - Docker/K8s management

4. **UI/UX Designer** (1)
   - Design system, user flows, prototypes

5. **Product Manager** (1)
   - Roadmap, user research, stakeholder management

### 11.2 Scaling Plan
- Add specialized roles as needed:
  - LaTeX/Typography Expert
  - ML Engineer (for custom models)
  - QA Engineer
  - Customer Success Manager

---

## 12. Timeline & Milestones

### Year 1 Roadmap

**Q1 2025: Foundation**
- Month 1: Architecture setup, basic editor
- Month 2: PDF compilation, user auth
- Month 3: First AI agent, file management

**Q2 2025: Collaboration**
- Month 4: Real-time editing
- Month 5: Comments and sharing
- Month 6: Full AI agent suite

**Q3 2025: Polish & Launch**
- Month 7: Performance optimization
- Month 8: Beta testing with universities
- Month 9: Public launch

**Q4 2025: Growth**
- Month 10: Template marketplace
- Month 11: Enterprise features
- Month 12: Mobile optimization

---

## 13. Conclusion

This technology stack and architecture provides:

1. **Developer Velocity**: TypeScript throughout, modern frameworks
2. **Scalability**: Horizontal scaling at every layer
3. **Cost Efficiency**: Smart choices like Cloudflare R2, efficient caching
4. **User Experience**: Fast, responsive, collaborative
5. **Differentiation**: AI-first approach sets apart from competitors

The recommended stack balances:
- **Proven technologies** (PostgreSQL, Redis, React)
- **Modern approaches** (Next.js App Router, tRPC)
- **Startup-friendly choices** (Vercel, Railway, shadcn/ui)

This architecture can start simple and scale to millions of users without major rewrites, perfect for a growing startup.

---

## Appendix A: Technology Alternatives Considered

| Component | Chosen | Alternatives | Why Chosen |
|-----------|--------|--------------|------------|
| Frontend Framework | Next.js | Remix, SvelteKit, Vue/Nuxt | Better ecosystem, React talent pool |
| Editor | Monaco | CodeMirror 6, ProseMirror | VS Code familiarity, LaTeX support |
| Database | PostgreSQL | MongoDB, MySQL | ACID compliance, complex queries |
| Real-time | Y.js | OT.js, ShareJS | Better offline support, active development |
| Hosting | Vercel + Railway | AWS, GCP, Azure | Simplicity for small team |
| UI Library | shadcn/ui | MUI, Ant Design, Chakra | Customization, no lock-in |

## Appendix B: Cost Estimates (Monthly)

### Initial Phase (1000 users)
- Vercel: $20 (Pro plan)
- Railway: $20 (Starter)
- PostgreSQL: $20 (managed)
- Redis: $10 (managed)
- Cloudflare R2: $15 (storage + bandwidth)
- AI APIs: $500 (variable)
- **Total: ~$585/month**

### Growth Phase (10,000 users)
- Vercel: $150 (Team)
- Railway: $100 (Team)
- PostgreSQL: $100 (larger instance)
- Redis: $50
- Cloudflare R2: $200
- AI APIs: $5000
- Monitoring: $200
- **Total: ~$5,800/month**

### Scale Phase (100,000 users)
- Custom infrastructure on AWS/GCP
- Estimated: $25,000-50,000/month
- Requires dedicated DevOps team

---

*This PRD serves as a living document and should be updated as the product evolves and market conditions change.*