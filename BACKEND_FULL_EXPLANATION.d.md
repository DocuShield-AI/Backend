# DocuShield Backend — Complete Guide (Roman Urdu)

**Version:** reviews current codebase (2026-09-13)
**Note:** Ye document pure siakhi (theory) nahi hai — ye har module ka kaam, uska flow, aur har design decision ka "defense" (yaani **kyu ye kaam aise kiya gayee**) directly code se utha kar samjhata hai. Har technical term ko pehli dafa pe Urdu me samjhaya gaya hai.

---

## Table of Contents
1. [Backend kya hai — poora picture](#1-backend-kya-hai--poora-picture)
2. [Entry point: main.ts](#2-entry-point-maints)
3. [app.module.ts — sab modules ka map](#3-appmodulets--sab-modules-ka-map)
4. [common/ — cross-cutting infrastructure](#4-common--cross-cutting-infrastructure)
5. [Prisma module — database laag](#5-prisma-module--database-laag)
6. [Auth module — sab se important](#6-auth-module--sab-se-important)
7. [Workspaces module — tenancy](#7-workspaces-module--tenancy)
8. [Contracts module — file upload aur pipeline](#8-contracts-module--file-upload-aur-pipeline)
9. [Queue module — BullMQ jobs](#9-queue-module--bullmq-jobs)
10. [Subscriptions module — Stripe billing](#10-subscriptions-module--stripe-billing)
11. [Notifications module — n8n](#11-notifications-module--n8n)
12. [Data model — har table ki kahani](#12-data-model--har-table-ki-kahani)
13. [Poore end-to-end flows](#13-poore-end-to-end-flows)
14. [Defense section — har "kyu" ka jawab](#14-defense-section--har-kyu-ka-jawab)
15. [Terms glossary — sab lafzon ke maane](#15-terms-glossary--sab-lafzon-ke-maane)

---

## 1. Backend kya hai — poora picture

DocuShield ek **contract risk triage** platform hai. Matlab: koi company apne legal contracts (agreements, NDAs, rental agreements) upload karti hai, aur system un contracts ko AI se parse karta hai — har **clause** ko nikalta hai, us clause ko **embedding** (number ki list me convert) karta hai, phir **risk flag** karta hai (low/medium/high). Complicated AI kaam ek alag Python microservice karta hai.

**Backend ka kaam** — ye **API Gateway** hai. Matlab ye sab request ka darwaza hai:

| Cheez | Kaun karta hai |
|---|---|
| User signup/login/roles/sessions | Ye backend (auth module) |
| Company (workspace) aur invites | Ye backend (workspaces module) |
| Contract upload, hash-dedupe, queue me daalna | Ye backend (contracts + queue module) |
| Stripe se subscription lena | Ye backend (subscriptions module) |
| AI ka bhaari kaam (extract/embed/classify) | Alag Python microservice (BullMQ queue se job le kar) |
| n8n automation (payment notifications) | Alag n8n workflow (webhook se trigger) |

**Tech stack** (kya-kya use hota hai):
- **NestJS 11** — backend framework (TypeScript me likha). Explore karo to pata chalta hai ye mohabbat se structure banata hai: Modules → Controllers → Services → Repositories.
- **Prisma 6** — database ORM. TypeScript me database query likhne ka tarika, jo safe types ke sath hota hai.
- **Supabase Postgres + pgvector** — database. pgvector means Postgres me "vector" column type, jo AI embeddings store karne ke liye hai.
- **Redis** — ek in-memory database. High-speed cheezein: job queue, rate limiting, session store, role invalidation flags.
- **BullMQ** — Redis ke upar job queue system. Producer (backend) job daalta hai, worker (Python service) uthata hai.
- **Stripe** — payment gateway. Subscriptions ke liye.
- **JWT** — token system for sessions.
- **pino** — logging (structured/JSON logs).

**Architecture ka naqsha:**

```
Browser (React SPA) ──┬── HTTP ──► Backend (NestJS :4000)
                      │                 │
                      │      ┌──────────┴──────────┐
                      │      │  Global Guards       │
                      │      │  JWT ► Roles ► Throttle │
                      │      └──────────┬──────────┘
                      │                 ▼ Controllers
                      │                 ▼ Services
                      │                 ▼ Repositories
                      ▼                 ▼
                 (cookies me JWT)   Prisma ──► Supabase Postgres (+pgvector)
                                    BullMQ ──► Redis ──► Python AI worker
                                    Stripe (billing) / n8n (notifications)
```

---

## 2. Entry point: main.ts

Jab `npm run start` karte ho, sab se pehle **`src/main.ts`** chalta hai. Iska kaam NestJS app ko "bootstrap" (jaag) karna hai — banane se pehle us se related setup karna.

```ts
const app = await NestFactory.create(AppModule, { rawBody: true });
```

- `AppModule` — poore app ki jad (root). Har cheez yahi se shuru hoti hai.
- `{ rawBody: true }` — matlab Nest raw (original, untouched) request body ko bhi bacha kar rakhta hai. **Defense:** Stripe webhook signature verify karte waqt humein bilkul wohi bytes chahiye jo Stripe ne bheje thay — agar framework body ko parse kar ke phir JSON string bana kar signature check kare to data badal jayega aur signature fail ho jayega. Is liye raw body ka option.

```ts
app.useLogger(app.get(Logger));   // default Nest logger ko pino se replace
```
Logger module me pino (better logging) lagaya gaya. Khud ka structured logging system.

```ts
app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
```
**ValidationPipe** — har incoming request ke body ke akhar class-validator ke decorators check karta hai. `whitelist: true` matlab jo fields DTO me declared naheen, woh URL/body se **hata di jaati hain** (humara contract enforce hota hai). `transform: true` matlab data type conversion (e.g. `"5"` → `5`). **Defense:** koi aam aadmi zaroori data cheen kar extra fields bhej de to whitelist hata deti hai — injection attacks kam hoti hain.

```ts
const app = await app.listen(process.env.PORT ?? 4000);
```
Server ka address. `FRONTEND_URL` se CORS origin pin hai (`credentials: true` ke sath), kyunki browser ko cookies send/receive karne dena padta hai aur wildcard origin + credentials apple nahi hote.

---

## 3. app.module.ts — sab modules ka map

NestJS me app **modules** se banta hai. Module ek "box" hai jisme ek cheez ka poora saman hota hai (controller + service + dto + stuff). `app.module.ts` in sab ko import karta hai:

```
ConfigModule     (global) — .env file se settings
LoggerModule     (global) — logging kaam
CacheModule      (global) — Redis cache
RateLimitModule  (global) — throttling
PrismaModule     — database
QueueModule      — BullMQ
NotificationsModule — n8n client
SubscriptionsModule — Stripe
ContractsModule  — contracts
WorkspacesModule — companies/members
AuthModule       — signup/login/security
```

**Important cheez — `@Global()`:** Jo module `@Global()` hota hai, uska saara `exports` sab jagah available hota hai bina import kiye. Jaise `PrismaService` har jaga inject ho sakti hai.

`app.module.ts` me ek `configure()` hai:
```ts
consumer.apply(TraceIdMiddleware).forRoutes('*');
```
matlab har route pe trace-id middleware chalta hai (niche detail).

---

## 4. common/ — cross-cutting infrastructure

Yeh "common" folder wo cheez hai jo har module ke liye common hai — jis cheez ki zaroorat sab ko padti hai.

### 4.1 Logger (logging system)

**Problem:** Server pe thousands requests aati hain. Debug karne ke liye pata hona chahiye kaunsi request kis error se mili. Agar sirf `console.log` use karo to logs me koi mehfil nahi hoti — request ka step-to-step path pata nahi chalta.

**Solution — correlation/trace ID:**
- Har incoming request pe `x-request-id` header check hota hai. Agar client ne bheja to wahi, warna naya UUID (`randomUUID()`).
- `TraceIdMiddleware` is id ko **response header** me bhi daalta hai taake frontend/Postman me dikhe.
- Is id ko `AsyncLocalStorage` me save karta hai.

**Term — AsyncLocalStorage:** JavaScript single-threaded hai, par async code me kai cheezen ek saath chalti hain. AsyncLocalStorage ek "mehfil" hai — har request ka apna context (mehfil) jisme dala data us request ke har async step ko milta hai. Ye hume batata hai "is request ka traceId kya tha".

```ts
this.trace.run({ traceId }, () => next());
```
`run()` me jo code chalta hai, usko woh traceId milti hai. **Defense:** Errors ke waqt, log dekho to pata chalega ki kaunsi request fail hui — aur BulMQ job payload me bhi same traceId jaati hai (`ingestion.producer.ts`), is liye backend kitaab aur Python worker ke logs **ek saath jor sakein** — bilkul detective jaise threads mila karte hain.

- **Redaction:** `redact: ['req.headers.authorization', 'req.headers.cookie']` — log me token/cookie kabhi print nahi honge. **Defense:** Logs click hote hain, secrets leak ke liye popular. Pino unhe chhupata hai.

### 4.2 Cache (Redis)

`RedisCacheService` ek ioredis client banata hai. Lazy connect (palon ko hi connect hota hai jab zaroorat ho). `get/set/del` + JSON serialization. `Client` property se raw Redis client bhi milta hai — auth stores isi se chalti hain.

**Defense (lazy connect + error log):** Agar Redis down hai to app chalti to hai, sirf logs me error aata hai (fail-soft). Lekin database/queue aise nahi — wo fail-fast hote hain.

### 4.3 Rate Limit (throttling)

**Problem:** Koi bhi aadmi bot bana kar 10,000 requests/min bhej sakta hai — server overload, DB crash, doosri companies ka resources khatam.

**Solution — `@nestjs/throttler` with Redis storage:**
- **Tier 1: per-IP** — har IP max 100 requests/min (default).
- **Tier 2: per-workspace** — har workspace max 500 requests/min.

**Defense (Redis storage, not in-memory):** agar 2 ya zyada server replica (clones) chalte hain to in-memory counter DOUBBLE ho jayega (har server apna counter rakhega). Redis shared hai — counter ek jagah. Is liye storage Redis me hai.

`WorkspaceThrottlerGuard` tracker banata hai:
```ts
const workspaceId = req?.user?.workspaceId ?? req?.headers?.['x-workspace-id'];
```
Pehle verified JWT se `workspaceId` leta hai (sab se bharosa). Agar anonymous hai to IP se. **Defense:** header `x-workspace-id` sab apni marzi se bhej sakta hai — is liye primary source JWT hai, header sirf fallback.

**Guard order ka concept:** Nest me `APP_GUARD` global guard hote hain. Order: JwtAuthGuard (auth) → RolesGuard (role check) → WorkspaceThrottlerGuard (rate limit). Pehle user confirm hota hai, phir role, phir load check.

---

## 5. Prisma module — database laag

`PrismaService` extends `PrismaClient`, `onModuleInit` me `$connect()`, `onModuleDestroy` me `$disconnect()`.

**Database planets:** `prisma/schema.prisma` me models hain (tables). Har model ka `@map` batata hai ke table ka asli name kya hai (`@@map("workspaces")` → table `workspaces`). Field names camelCase hain (`createdAt`) lekin DB me snake_case (`created_at`) — ye Prisma ka feature hai.

**pgvector:** `Clause.embedding` ka type hai `Unsupported("vector(768)")`:
```prisma
embedding Unsupported("vector(768)")
```
Prisma is column ko "unsupported" maanta hai (wo isay query nahi kar sakta, type check nahi karta) — lekin column database me existing hota hai. Isme **768-dimensional vector** store hota hai — AI jo embedding banana janta hai. **Defense:** Prisma vectors ko na handle kare to safest approach "unsupported" declare karna hai — Prisma is column ko drop nahi karega mappings me.

**Migration se kehna (previous pour):** `DATABASE_URL` pooler hai (pgbouncer transaction mode) — API ke liye. `DIRECT_URL` direct connection — sirf Prisma migrations ke liye. Prisma migrations transaction/DDL ko pooler ke through nahi chala sakta, is liye direct URL.

**Transactions:** `prisma.$transaction(async (tx) => {...})` — andar ke saare queries **ek saath** commit hoti hain ya **sab cancel**. MATLAB bilkul saath-saath. Iska use auth signup me hota hai (niche dekho). Term: **ACID** — Atomic (sab ya kuch nahi), Consistent, Isolated, Durable.

---

## 6. Auth module — sab se important

### 6.1 Concepts pehle (terms)

- **JWT (JSON Web Token):** Ek string — `header.payload.signature`. Isme user ki info (claims) hoti hai: `sub` (user id), `workspaceId`, `role`, `email`. Server signature me secret hota hai, is liye koi token ki claims badal kar bhej de to signature fail hota hai. "Unsigned" token = nakli.
- **Access token:** Chhoti life (default 15 min). Har request ke sath bheja jaata hai. **Defense:** age 15 min → agar chori ho jaye to thode time ki aukat hai.
- **Refresh token:** Lambi life (7 din). Sirf `/auth/refresh` pe use hota hai, taake naya access token mile. Jaise "session ka master key".
- **httpOnly cookie:** Browser JS se token chhu nahi sakta (sirf HTTP header bhejta hai). **Defense:** Agar XSS attack (malicious script) ho to bhi script token nahi utha sakti — localStorage me token hota to script utha leta.

### 6.2 Global security guards

```
JwtAuthGuard (global APP_GUARD) — har route protect
        │
        ▼  public route? (@Public) → allow
        ▼  else → token verify (JwtStrategy)
RolesGuard (global) — @Roles() se specific roles
WorkspaceThrottlerGuard — rate limit
```

**Defense — "secure by default":** Naya route banaya to woh **protected** hai jab tak `@Public()` nahi lagate. Galatfehmi ho toh fail "closed" hota hai (protected), "open" nahi. Ye direction safe hai — koi pehle route khula yaad nahi reh sakta.

### 6.3 JwtStrategy — token kaise verify hoti hai

```ts
export function fromCookieOrBearer(req) {
  const bearer = ExtractJwt.fromAuthHeaderAsBearerToken()(req);
  if (bearer) return bearer;
  return req.cookies?.['access_token'] ?? null;
}
```
Browser httpOnly cookie se token leta hai; `Authorization: Bearer ...` header dev/scripted clients ke liye.

**validate() ka fast path:**
```ts
if (!(await roles.isInvalidated(payload.sub))) {
  return { userId, workspaceId, role, email }; // claims bharosa
}
```
Normal case: token ke claims pe **bharosa** — koi DB query nahi. **Defense:** Har request DB pe na jaaye — ye hot path (performance) ke liye. Lekin inka trade-off: agar role badal gaye to token 15 min tak puraana role batayegi. Iska jawab **RoleInvalidationStore** (niche).

### 6.4 Signup (create) — workspace + user transaction

```
POST /auth/signup { email, password, workspaceName, type:"create" }
  │
  ▼ AuthService.signup()
  ▼ password.hash()  ← bcrypt, 12 rounds (config BCRYPT_SALT_ROUNDS)
  ▼ $transaction:
      • tx.workspace.create({ name })
      • tx.user.create({ workspaceId: workspace.id, role: admin })
  ▼ issueTokens(user) → access + refresh cookie
```

**Defense kya-kya:**
- **Transaction:** user ke bina workspace nahi reh sakta (`workspaceId` NOT NULL FK). Agar transaction na ho to aadha signup (orphan workspace) reh jata. Is liye dono ek transaction me.
- **`err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002'`:** email unique constraint — agar do log alag-alag saath me same email signup kar lein, tab pre-check se bhi dono pass ho sakte hain, phir dono insert karne ki koshish karte → P2002 (unique violation). Isse `409 Conflict`. **Defense:** pre-check pe rely nahi, constraint ko bharosa.
- **PasswordService:** bcrypt `BCRYPT_SALT_ROUNDS` config se — production me zyada rounds (slow brute-force), tests me kam (fast). Isolating service means algorithm badalna admin lagana (single change point).

### 6.5 Signup (join) — invite ke sath

```
POST /auth/signup { email, password, type:"join", inviteCode:"ABC123..." }
  ▼ $transaction:
     const invite = tx.invitation.findUnique({ where:{ code } })
     if (!invite) → 400 "Invalid invite code"
     if (invite.expiresAt < now) → 400 "Invite code has expired"
     const claimed = tx.invitation.updateMany({
        where: { id: invite.id, usedAt: null },
        data: { usedAt: now }
     })
     if (claimed.count !== 1) → 400 "Invite code has already been used"
     tx.user.create({ workspaceId: invite.workspaceId, role: invite.role })
     tx.invitation.update({ usedByUserId: created.id })
```

**Defense — atomic "single-use":** `updateMany(where usedAt:null)` ek "consumer-wins" primitive hai. Do admins ek hi saath same code use karein → sirf ek `updateMany` 1 row match karega (doosra 0). Matlab code **ek hi dafa** use ho sakta hai — server crash ho jaye to bhi code dead rehta hai (usedAt set ho gaya, transaction commit hone se pehle crash pe rollback). "claimed.count !== 1" pe throw → dusra banda useless.

### 6.6 Login

```
POST /auth/login { email, password }
  ▼ user = findUnique(email)
  ▼ ok = user && bcrypt.compare(password, user.passwordHash)
  ▼ if (!ok) → UnauthorizedException('Invalid email or password')
```

**Defense — same error for both:** "email nahi mila" vs "password galat" — agar alag-alag messages diye to koi bhi user enumeration kar sakta hai (us email ke user hain ya nahi pata). Is liye ek hi message.

### 6.7 Refresh — rotation (har baar naya token)

```
POST /auth/refresh  (cookie me refresh token)
  ▼ payload = verify(refreshToken, JWT_REFRESH_SECRET)  ← ALAG secret!
  ▼ if (!isValid(sub, jti)) {
       if (wasSpent(sub, jti)) → replay detected → revokeAll(sub)
       throw 401
     }
  ▼ user = findUnique(sub)   ← role/account change capture
  ▼ retire(sub, jti)          ← purana token "spent"
  ▼ issueTokens(user)         ← naya pair
```

**RefreshTokenStore (Redis):** Do sets per user — `live` (us waqt woh tokens live) aur `spent` (jo rotation me retire hue). `sadd/srem/sismember` Redis set operations.

**Defense — replay detection:** Refresh token ko **chaar** dafa use karna bigadta hai. Rotation means: har refresh pe purana token retired hota hai. Agar koi purana (spent) token dobara aaye — iska matlab woh token ki nakal kahin thi (legitimate client ne tho throw kar diya). Yeh ek active attack hai → **revokeAll** (saari sessions khatam). But aitbaar "unknown" token (logout/expiry) pe sirf reject karte hain — warna ek puraana browser tab logout ke baad token replay kare to woh bhi sessions garde — attack jaisa dikhe, magar xD innocent.

- **Fail-closed (bharosa na):** Redis down → refresh pe 503 (`ServiceUnavailableException`). **Defense:** Agar store na cheek, to token "valid" mana lega to revocation bhi kam hota hai — is liye fail-closed.

### 6.8 Logout

```
POST /auth/logout → payload verify → refreshTokens.forget(sub, jti) → clear cookies
```
Sirf us jti ki entry `live` se hata deta hai — doosre devices ke tokens safe rehte hain. `clearCookie(path:'/')` — puraana cookie bhi path match par hi hat-ti hai.

### 6.9 issueTokens — dual secrets

```ts
const [accessToken, refreshToken] = await Promise.all([
  jwt.signAsync(payload),                    // JWT_SECRET
  jwt.signAsync({...payload, jti}, { secret: JWT_REFRESH_SECRET, expiresIn: '7d' })
]);
```
- **Dual secrets:** access token ke secret se refresh token validate NAHI hota. Agar access token leak ho jaye to attacker uske saath naye token nahi bana sakta (refresh mangwana bhi secret ke baad hota hai). Alag secret = alag capability.
- **Refresh token me `jti` (unique id):** Har refresh token ki apni pehchaan. Ye `jti` hi store me record hoti hai — is tarah ek session revoke kar ke doosre ko nahi cheenta.
- **`secondsUntil(decoded.exp)`:** Redis TTL token ke `exp` se laiya jata hai — is liye record kabhi token ke age ke sath mismatch nahi hoga.
- **`roleInvalidations.clear(user.id)`:** Naye token ke claims me fresh role hai, to puraana flag redundant — hatao.

**Access token hi stateless (hot path), refresh token stateful (Redis):** Har API call pe store check karna = poore app ko Redis pe baitha dena. Access token 15 min ka bound hai — isliye sirf uski TTL pe bharosa. Refresh token (jo kamm baar use hota hai) ko store se protect karte hain.

### 6.10 Role invalidation — instant role change

**Problem:** JWT me role baked hai (15 min tak purana). Admin ne kisi ko demote kiya → us user ka new role 15 min tak nahi dikhega.

**Solution — `RoleInvalidationStore` (Redis)|:**
```ts
invalidate(userId, ttlSeconds): sadd(`auth:role-invalidated:${userId}`, '1') + expire
isInvalidated(userId): sismember(...) === 1
```
- Admin role change karta hai → `invalidate(userId)`.
- Agle request pe JwtStrategy check karta hai: agar flag hai → DB se fresh user row parhe (single tiny query) → fresh role.
- Sirf flagged users hi DB read karte hain — aam khalqa fast path pe.

**Defense — fail-OPEN health check:** Agar Redis down ho to `isInvalidated()` returns `false` (no blocking). **Kyu fail-open?** Yeh store ek "acceleration" hai, doosri darja ki security. Agar ye baraye haq hoti to app availability kharab hoti (Redis down = whole API down). Role aap kochhu time ke liye old rahegi to minor hai — jo flag write bhi fail ho jaye, bas log hota hai. Ye faasla `RefreshTokenStore` se hai jo fail-closed hai (wahan fail-open dangerous hai kyunki revocation silent disable ho jayegi).

### 6.11 OAuth (Google login)

```
GET /auth/google  → passport redirect to Google
GET /auth/google/callback → Google wapis bhejta hai
  ▼ GoogleStrategy.validate(): email verified check
  ▼ AuthService.validateOAuthLogin(profile, inviteCode from state)
     • existing user → login (record provider if first time)
     • new + invite → joinWorkspaceWithInvite
     • new + no invite → create workspace
  ▼ setSessionCookies → res.redirect(OAUTH_SUCCESS_REDIRECT)
```

**Defenses:**
- **Email verified check (`email.verified === false`):** Hum user ki pehchaan email se match karte hain. Agar Google ka unverified email allow karein, to koi bhi us email ko provider pe register kara kar existing account me ghuss sakta hai — account takeover. Is liye unverified email → UnauthorizedException.
- **inviteCode via OAuth `state`:** `/auth/google?inviteCode=CODE` pehle code ko `state` me JSON string banata hai; Google state ko wapis echo karta hai (state is NOT CSRF here — flow me abhi session nahi hai).
- **OAuth users ke liye password:** `passwordHash(`${randomUUID()}${randomUUID()}`)` — aisi hash jo kisi ke passord ki nahi hai. **Defense:** Password route us account ke liye band rehta hai jab tak wo password reset na karay — koi random password guess/set nahi kar sakta.
- **First-time + invite → role from invite:** Jab email abhi account nahi hai lekin invite code diya — wo sangat workspace me join hota hai, naya workspace nahi banata.

**GoogleStrategy factory (auth.module) — lazy init:** 
```ts
if (!clientId || !clientSecret) return null; // warn + skip
```
**Defense:** passport-google-oauth20 empty clientID pe throw karta hai — agar unconditional register karein to bina OAuth config wale device pe poora app boot hi na ho. Is liye conditional.

### 6.12 Cookies

```ts
this.sessionCookieOptions(maxAge) {
  httpOnly: true, sameSite: 'lax', secure: NODE_ENV === 'production', path: '/'
}
```
- `httpOnly` — XSS se token chhupa.
- `sameSite: 'lax'` — cross-site POST pe cookie nahi jaati (CSRF protection ka hissa) — browser top-level navigation pe allowed rehta hai (OAuth redirect ke liye).
- `secure` sirf production me — localhost HTTP ke liye kabhi cookie secure option dev me nahi.
- Max-age env ke TTL se calculated — cookie token se zyada door life me nahi reh sakti.

---

## 7. Workspaces module — tenancy

**Concepts:**
- **Workspace** = company. Har user ka aktar maalik/malikiya kisi na kisi workspace se jude hain. Har contract/text me `workspaceId`.
- **Tenant** = workspace. Doosri company ke data se ilaah (isolation) — multi-tenant app.

**Controller ki khas baat — no `/:id` routes:**
```ts
@Controller('workspaces')
@Get('me') `/me/members` `/invite` `/me/members/:userId/role`
```
Har route `@CurrentUser()` se `workspaceId` leta hai — URL/body se NAAHI.

**Defense:** Agar route `/workspaces/:id` hote to koi apni hi workspace ko नहीं, doosre ki id URL me daal sakta tha (`/workspaces/OTHER-COMPANY-ID/...`). No `:id` route by design — id hi sirf token se. Yeh object-level authorization (IDOR attack) ka peek protection hai.

**Flows:**
1. **`GET /workspaces/me`** → summary (name, plan, createdAt, memberCount via `_count.users`).
2. **`GET /workspaces/me/members`** → `prisma.user.findMany({ where:{ workspaceId }, select:{...} })`. Select me `passwordHash` kabhi nahi — **Defense:** password hash "select" me nahi aata, is liye ye route se leak nahi ho sakti (defense-in-depth).
3. **`POST /workspaces/invite` (admin)** → `randomBytes(6).toString('hex').toUpperCase()` = 12 hex chars (48 bit entropy). Role default `viewer` (least privilege). `expiresInDays` default 7.
4. **`PATCH /me/members/:userId/role` (admin)** → role change + `roleInvalidations.invalidate(userId, accessTokenTtlSeconds())`.

**Defense — scope in query:** `prisma.user.findFirst({ where: { id: userId, workspaceId } })` — admin doosre workspace ka member update karne ki koshish kare to `findFirst` `null` → NotFound. Admin apne workspace me bhi kisi ko update kar sakta hai, par sirf apna.

**`isMember()` helper** — defence-in-depth for things that can't rely on query filters. (Note: currently unused — legacy.)

---

## 8. Contracts module — file upload aur pipeline

**Flow (upload):**
```
POST /contracts/upload  (file, Roles: admin or legal)
  │  FileInterceptor (memoryStorage, limits fileSize: 25MB)
  │  └─ multer file ko memory me rakhta hai (RAM)
  ▼ validateAndHashContract(file) → { fileName, fileHash }
       • extension/mime check (validator)
       • SHA-256 hash of bytes
  ▼ workspaceId = user.workspaceId, uploadedByUserId = user.userId   ← TOKEN se
  ▼ isDuplicate(workspaceId, fileHash) 
       └─ repository.findByHash → unique (workspace_id, file_hash) index
  ▼ if duplicate → return { duplicate: true, message: 'File already uploaded' }
  ▼ uploadContract():
       contract = repository.create({..., fileUrl: `s3://contracts/${workspaceId}/${fileName}`, status:'queued'})
       { jobId } = producer.enqueue({ contractId, workspaceId, fileUrl, fileHash })
       repository.createIngestionJob({ contractId, bullmqJobId: jobId })
       return contract
```

**`fileUrl` s3://... — kya contract?** Backend actual S3 upload NAAHI karta — ye URL AI microservice ke liye ek promise/contract hai. Python worker ko batata hai "file ko s3 se lo". Ye seam hai jo backend ↔ AI service ke beech hai.

**Defense — SHA-256 hash dedupe:**
- Same file dobara upload → same hash → unique constraint (`uniq_contract_per_workspace_hash`) me collide → "duplicate" flagged. **Kya fayda?** Dooba billing nahi (AI processing me cost), DB me garbage nahi. Ye **idempotent** (idempotency = same operation dobara karne se same result) upload hai.

**Controllers routes:**
- `GET /contracts` (admin, legal, viewer) → list. `listContracts(workspaceId, userId, role)` me:
```ts
return repository.list(workspaceId, role === Role.viewer ? userId : undefined);
```
  Viewer jab apne hi upload dekhta hai — filter query me hi hai (`where` me `uploadedByUserId`). **Defense:** Dedoosra viewer/tanant ki rows kabhi service tak pahunchti hi nahi — query level par scoped. Post-filter (fetch kar ke filter) nahi — kyunki post-filter me koi baad ki refactor (log ya response) accidentally leak kar sakta hai.

- `GET /:id` → `findByIdWithIngestion(id, workspaceId)` — findFirst with BOTH id and workspaceId.
- `GET /:id/status` → status + stage for polling.

**Defense — 404 not 403:** doosre workspace ki id pe `findFirst` null → `NotFoundException` (404). **Kyu 404, 403 nahi?** 403 batata hai "correct, ye id exists hai, bas tumhe allowed nahi". Ye id ka existence leak karta hai (attacker ek dum behtar enumeration kar sakta). 404 sab ke liye same response. Ye "IDOR/OIDC oracle" protection.

**File validator:** `file-validator.ts` — check karne ke liye `file` undefined, size (25MB limit interceptor se fauz), types (PDF/DOCX etc.). `fileHash` SHA-256.

---

## 9. Queue module — BullMQ jobs

**Concept — queue kyun?**
AI ka kaam (extract text, chunk, embed 768-dim vector, classify risk) **heavy** hai — URL download, PDF parse, LLM/model runs. Agar backend ise synchronously kare to:
- User ko response 30-60 second tak atka rahe.
- Backend load full ho, doosre requests ki bandwidth kha jaaye.

**Solution — async job queue:**
```
backend (producer) ──add job──► Redis queue ──► Python worker (consumer) ──► results
```
Request instantly 200 deta hai (contract queued), AI background me kaam karta hai. Backend **producer** hai, Python worker **consumer**.

**Producer code:**
```ts
queue.add('ingest', { ...payload, traceId: ... }, {
  removeOnComplete: 100,
  removeOnFail: 500,
  attempts: 3,
  backoff: { type: 'exponential', delay: 2_000 },
});
```
- `attempts: 3` — worker fail → 3 dafa try.
- `backoff: exponential 2s` — fail hone pe pehle 2s, phir 4s, phir 8s. **Defense:** transient errors (Redis/DB glitch) khaali retry se theek ho jayengi — bhaari hammering nahi.
- `removeOnComplete: 100 / removeOnFail: 500` — completed jobs ka last 100, failed ka 500 history me rakho. **Defense:** queue ki memory unlimited na ho.
- `traceId` propagate — `THIs traceId ?? this.trace.getTraceId()` — job payload me bhi jaata hai taake Python worker ke logs ko bhi trace kiya jaye.

**Global module:** QueueModule `@Global` hai — `IngestionProducer` kisi bhi module me inject ho sakta hai (contracts kar raha hai). RabbitMQ vs BullMQ — BullMQ Redis ke upar simple, popular.

---

## 10. Subscriptions module — Stripe billing

**Flow 1 — Checkout:**
```
POST /subscriptions/checkout  (admin, body: { plan })
  ▼ workspaceId = @CurrentUser()  ← token se, body se nahi
  ▼ createCheckoutSession({...dto, workspaceId})
     priceIdForPlan(plan) → STRIPE_PRICE_PRO / STRIPE_PRICE_ENTERPRISE
     stripe.checkout.sessions.create({
        mode: 'subscription',
        line_items: [{ price, quantity: 1 }],
        metadata: { workspaceId, plan },      ← webhook me unhe milta hai
        success_url: `${PUBLIC_BASE_URL}/subscriptions/success?session_id=...`,
        cancel_url: `${PUBLIC_BASE_URL}/subscriptions/cancel`
     }, { idempotencyKey: `checkout-${workspaceId}-${plan}` })
  ▼ return { url: session.url, sessionId }
```

**Defense — idempotencyKey:** Pay button pe double-click / frontend retry → same key → Stripe same session return karta hai, DOOSRA chargeable session nahi banata. **Defense — workspaceId token se:** DTO me `workspaceId` hai (declared), lekin controller `{...dto, workspaceId}` se override karta hai — body ka value nahi. Warna koi bhi authenticated user doosre workspace ke liye checkout start kar sakta tha.

**Flow 2 — Webhook:**
Stripe server-to-server call karta hai. Stripe ke paas JWT nahi — is liye route `@Public()` hai. **Auth is route ka — signature verify:**
```
POST /subscriptions/webhook (stripe-signature header, raw body)
  ▼ rawBody check (RawBodyRequest)
  ▼ verifyWebhookSignature(raw, signature) → stripe.webhooks.constructEvent(...)
     fail → 400 "Invalid webhook signature"
  ▼ handleEvent(event)
```

**Defense (rawBody + signature):** Stripe world me secret `webhookSecret` shared hai. `constructEvent` payload ke exact bytes se HMAC-style signature banata hai aur compare. Agar request tamper ya nakli → signature mismatch → reject. Axir Stripe "webhook signing" har baar bot se bachaata hai (Stripe retries bhejta hai).

**handleEvent → event types:**
- `checkout.session.completed` → `onCheckoutCompleted`:
  - metadata se `workspaceId` + `plan`
  - `subscriptions.retrieve(subscriptionId)` → `currentPeriodEnd` (see `periodEndOf`)
  - `prisma.subscription.upsert(where: { workspaceId }, ...)` — create ya update
  - `prisma.workspace.update({ plan })` — workspace ka plan upgrade (catch log)
  - `n8n.notifyPaymentSuccess({...})` — n8n automation fire
- `customer.subscription.updated` / `deleted` → `onSubscriptionChanged`: Stripe status (canceled/past_due/active) → DB map.

**`periodEndOf` — Stripe SDK 22.6.0 / API `2026-08-26.dahlia`:** Naya Stripe API SDK ne `current_period_end` top-level field hata diya — ab `billing_schedules[0].bill_until` se period end milta hai, warna `billing_cycle_anchor` fallback.

**`CreateCheckoutDto`:** `plan: 'pro' | 'enterprise'` — humari subscription plans (free default workspace pe upgrades).

---

## 11. Notifications module — n8n

`N8nWebhookClient` — simple HTTP client jo payment-success event n8n workflow ko POST karta hai (`N8N_WEBHOOK_URL`).

- `if (!this.url)` → warn + skip (feature optional).
- `fetch(url, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({type:'payment.success', ...payload}) })`.
- Fail pe log + continue — **Defense:** notification failure billing flow ko kabhi break na kare (`try/catch`).

**Data contract:** `PaymentSuccessWebhookPayload` (`workspaceId, plan, stripeCustomerId, stripeSubscriptionId, currentPeriodEnd, occurredAt`) — wo shape jo n8n workflows consume karta hai.

---

## 12. Data model — har table ki kahani

**`workspaces`** — companies. `plan: Plan (free|pro|enterprise) default free`. Har cheez ek workspace ke under.

**`users`** — `workspaceId` FK, `email UNIQUE`, `passwordHash`, `role: Role (admin|legal|viewer) default viewer`, `oauthProvider`, `createdAt`. Index `users(workspace_id)` (secondary index commit).

**`invitations`** — (NOTICE: schema me model hai, DB me ABHI NAHI — migration pending, ye blocker hai). `code UNIQUE`, `role` (baked-in at creation), `expiresAt`, `usedAt`, `usedByUserId`, `createdByUserId`. Index `(workspace_id)`.

**`subscriptions`** — `workspaceId UNIQUE` (ek workspace = ek subscription), `stripeCustomerId`, `stripeSubscriptionId`, `status (active|past_due|canceled)`, `currentPeriodEnd`. Index `(stripeSubscriptionId)`.

**`contracts`** — `workspaceId`, `uploadedByUserId`, `fileName`, `fileHash`, `fileUrl`, `status (queued|extracting|embedding|classifying|ready|failed)`. **Unique constraint `(workspace_id, file_hash)`** — dedupe physical guarantee. FK `uploadedByUser_id → users` — user delete pe RESTRICT.

**`ingestion_jobs`** — `contractId UNIQUE` (one-to-one with contract), `bullmqJobId` (jo bhi job id di gayi; used to trace UI with BullMQ), `stage (extract|chunk|embed|classify)`, `attempts`, `lastError`, `updatedAt`.

**`clauses`** — `contractId`, `clauseType`, `clauseText`, `pageNumber`, `embedding vector(768)`, `riskLevel (low|medium|high|pending)`, `confidenceScore`, `reasoning`. Index `(contractId)`; HNSW index on embedding (commit ka doul, verify pending).

**`risk_flags`** — `clauseId` + `contractId` (denormalized for list queries), `riskLevel`, `category`, `resolved`, `createdAt`. Indexes `(clauseId)`, `(contractId)`.

**`notification_logs`** — `riskFlagId`, `channel: (slack|email)`, `status: (pending|sent|failed)`, `retryCount`, `sentAt`. Index `(riskFlagId)`.

**`audit_logs`** — compliance trail: `contractId`, optional `clauseId`, `action`, `riskLevel`, `confidence`, `actorType: (ai|human)`, `createdAt`. Indexes `(contractId)`, `(clauseId)`.

**`rag_query_cache`** — RAG (Retrieval-Augmented Generation) question cache: `contractId`, `normalizedQuestion`, `answer`, `sourceClauseIds`, `expiresAt`. **Unique `(contract_id, normalized_question)`** — same saved question per contract, unique.

**Why these tables?** Har AI consumer (Python) inhi tables ko populate karta hai: clauses fill, risk_flags, audit_logs, rag cache. Backend unhe read-only read karta hai frontend ke liye. So schema is the **contract between backend and AI service**.

---

## 13. Poore end-to-end flows

### Flow A — Signup (create) se dashboard tak
1. User SPA pe signup form → `POST /auth/signup`.
2. AuthService bcrypt hash → transaction (workspace + admin).
3. issueTokens → access/refresh cookies set (httpOnly).
4. Response `{ user }` → React redirects to /contracts.
5. SPA boot pe `GET /auth/me` → JwtStrategy (cookie se token) → `{user}` → UI knows who's logged in.

### Flow B — Invite + join (team build)
1. Admin: `POST /workspaces/invite { role?, expiresInDays? }` → middleware: RolesGuard (admin) → service → `invitation` row + code.
2. Admin sends code to teammate (WhatsApp/거).
3. Teammate: signup pe `type:"join", inviteCode`.
4. Atomic claim → user created with invite role/viewer.
5. Tokens set, dashboard → sees contracts (viewer scope: sirf apne uploads).

### Flow C — Contract upload → AI ingestion → status polling
1. `POST /contracts/upload` (admin/legal) → multer RAM → validate + SHA-256.
2. dedupe check → (optional) `{duplicate:true}` aaram se.
3. contract row (queued) → BullMQ job (`global traceId`) → ingestion_jobs row.
4. Response `{ duplicate:false, contract }` fast 200.
5. SPA polls `GET /contracts/:id/status` — RabbitMQ whatever -> `{status, stage}`.
6. Python worker extracts/chunks/embeds/classifies → updates staging, clauses, risk flags, audit.
7. Status becomes `ready` → SPA shows clauses + risks.

### Flow D — Billing
1. Admin: `POST /subscriptions/checkout {plan}` → Stripe Checkout URL.
2. User pays on Stripe hosted page → Stripe redirects to success URL.
3. Stripe POSTs `checkout.session.completed` webhook → signature verify → upsert subscription + workspace plan upgrade + n8n notification.
4. Future updates: `customer.subscription.updated/deleted` → status sync.
5. n8n receives `payment.success` → Annas ki automation (Slack/email/new business workflow).

### Flow E — Logout / session
`POST /auth/logout` → refresh token forget + clear cookies. Refresh pe purana tab `refresh` kiya? Redis `spent` me nahi, sirf `live` se hataya — tab reject hone pe wasSpent false ho chhupa... (realistically session ends). Doosre device challa.

---

## 14. Defense section — har "kyu" ka jawab

| # | Decision | Kyu (defense) |
|---|---|---|
| 1 | Tokens httpOnly cookies me (localStorage nahi) | XSS: script JS ke paas token nahi aa sakta |
| 2 | Access vs refresh — 2 alag secrets | Leaked access token se naya token nahi banta (refresh protected) |
| 3 | Access token 15m, refresh 7d | Chori ho jaye to chorta window; sessions 7 din alive |
| 4 | Refresh rotation + spent set | Replay detection; spent token = leaked copy → revokeAll |
| 5 | RefreshTokenStore fail-closed | Revocation kabhi secretly disable na ho |
| 6 | RoleInvalidationStore fail-open | Availability; ye secondary only |
| 7 | Global guards (auth-first) | New route default protected; safe failure direction |
| 8 | 404 vs 403 foreign contract | Existence leak nahi hoti (id oracle) |
| 9 | Viewer scope query me `where` | Data-plane isolation; post-filter nahi |
| 10 | Workspace id sirf token se | IDOR — apni dushmani ki id pass nahi |
| 11 | Atomic invite claim `updateMany usedAt:null` | Single-use under race/crash |
| 12 | Unified login error | User enumeration nahi |
| 13 | OAuth email verified check | Account takeover prevention |
| 14 | bcrypt with config rounds | Slow hashing = slow brute-force; tests tuned |
| 15 | BullMQ async queue | Heavy AI abhi block nahi; retries + backoff |
| 16 | checkout idempotencyKey | Double-click = same session, no double charge |
| 17 | Webhook rawBody + signature | Exact-bytes auth; tamper/nakli reject |
| 18 | Rate limit Redis storage | Replica-safe; one shared counter |
| 19 | TraceId + AsyncLocalStorage | Debugging across backend + Python worker |
| 20 | pino redaction (auth/cookie) | Secrets logs me kabhi nahi |
| 21 | Repository layer | Query separation; testable; reusability |
| 22 | Unique `(workspace, hash)` + hash dedupe | Idempotent uploads — no double billing, no garbage |
| 23 | `password_hash` kabhi `select` nahi | Defense-in-depth: leaks impossible via route |
| 24 | `@Roles` narrows, never grants | Forgot decorator = protected, not public |
| 25 | Lazy Google strategy | No OAuth creds → app still boots |
| 26 | Whitelist validation pipe | Extra fields strip; contract enforced |
| 27 | `current_period_end` via `billing_schedules[].bill_until` | Stripe 2026-08 API removed old field; account correct billing |
| 28 | S3 URL as seam, no real upload | Backend↔AI microservice decoupling contract |
| 29 | Workspace plan upgrade `.catch(()=>{})` with log | Billing failure must not 500 the webhook gracefully |
| 30 | n8n notification try/catch non-blocking | Notification outage never breaks billing response |

---

## 15. Terms glossary — sab lafzon ke maane

- **API Gateway** — sab requests ka ek gate; services ko ek jagah se expose.
- **Module** — NestJS me group: controller+service+dto+related stuff, ek box.
- **Controller** — HTTP route ka receiver; request lena, service ko call karna, response bhejna.
- **Service** — business logic; controller se alag **layered**.
- **Repository** — database queries ka layer alag; services yahan se data mangti hain.
- **DTO (Data Transfer Object)** — request body ka shape + validation rules (class-validator).
- **DI / IoC** — Nest apne aap dependencies banata/inject karta hai (constructor me batane se mil jaati hain). `Injectable()` = Nest le sakta hai.
- **Guard** — request route tak jane se pehle check; auth/roles. `canActivate()` true → allow, false/throw → deny.
- **Decorator** — `@Public()`, `@Roles(...)`, `@CurrentUser()` — function/metadata lagane ka TypeScript suffix. `@Roles` SetMetadata use karta hai, RolesGuard Reflector se parhta hai.
- **Interceptor** — request/response ka around (e.g., `FileInterceptor` for multer uploads).
- **Middleware** — request pe har route se pehle (e.g., trace-id).
- **Pipe** — data transform/validation (global ValidationPipe).
- **JWT** — signed token: `header.payload.signature`; claims trustable.
- **Bearer token** — `Authorization: Bearer <token>` header se token bhejna.
- **httpOnly cookie** — JS na chhu sake; sirf browser HTTP layer.
- **XSS** — malicious script via input; httpOnly+redaction uska jawab.
- **CSRF** — cross-site forged request; `sameSite:lax` uska defense.
- **Secret signing** — JWT signature ki hash; secret ke bina token verify/generate nahi.
- **bcrypt** — password hashing with salt+rounds; slow by design.
- **Hash (SHA-256)** — one-way digest; same file → same hash (dedupe).
- **Idempotent** — same operation twice → same result; no duplicate side-effect.
- **Transaction** — all-or-nothing batch; ACID.
- **Unique constraint** — DB physical guarantee; dups rejected.
- **Rate limiting / throttle** — per-key max requests/time; DoS prime guard.
- **BullMQ / queue** — job queue on Redis: producer adds, worker consumes async.
- **Retry/backoff** — fail pe re-try; exponential wait between attempts.
- **Trace/Correlation ID** — one request → one id across logs/services.
- **AsyncLocalStorage** — per-request async context (traceId le jata hai).
- **Webhook** — external service (Stripe) ko humara endpoint callback.
- **HMAC / Webhook signature** — secret-based integrity check of payload bytes.
- **rawBody** — original request bytes kept for signature verification.
- **OAuth 2.0 / Google OAuth** — third-party login; Google user info (email, profile) milta hai.
- **Structured logging** — JSON logs with fields (`req.id`, level) — filterable/searchable.
- **Redaction** — log output me sensitive fields hide karna.
- **pgvector** — Postgres vector type for embeddings; similarity search.
- **Embedding** — text → list of numbers (vector) that AI/ML can compare.
- **HNSW index** — pgvector index type for fast approximate vector search.
- **Pooler / pgbouncer** — connection pooling infront of Postgres; Prisma migrations use direct.
- **ORM** — object-relation mapping; Prisma maps TS models ↔ SQL tables.
- **Migration** — DB schema change tracked as SQL files; applies in order.
- **Environment (.env)** — config/keys per environment (dev/prod) — gitignored, `.env.example` reference.
- **Global guard (APP_GUARD)** — guard applied to every route.
- **Reflector** — Nest metadata reader (decorators → guards).
- **Least privilege** — minimize permissions by default (viewer default role).
- **Defense in depth** — multiple independent layers (hash select, 404, validation …).
- **IDOR** — insecure direct object reference; workspace-id-from-token uska jawab.
- **Fails-closed / fails-open** — on dependency failure: deny (closed) vs continue degraded (open).

---

*Is document ki sifarish: peers ne `invitations` migration aur dependencies install karni hain (ARCHITECTURE_REVIEW.d.md me B1/B2/B3 ko dekho) us se pehle ye module flows test kar paoge.*