# Supabase 설정 가이드

MODLai의 인증 + DB + 스토리지를 Supabase 하나로 관리합니다. 대략 **15-20분** 걸려요.

## 📋 체크리스트

- [ ] 1. Supabase 프로젝트 생성
- [ ] 2. 스키마 SQL 실행
- [ ] 3. Storage 버킷 SQL 실행
- [ ] 4. 결제 PG 마이그레이션 실행 (migration-002)
- [ ] 5. Fashion Model 마이그레이션 실행 (migration-003)
- [ ] 6. Channel Publishing 마이그레이션 실행 (migration-004)
- [ ] 7. Insights & Analytics 마이그레이션 실행 (migration-005)
- [ ] 8. Product Masters + Import 마이그레이션 실행 (migration-006)
- [ ] 9. 마스터 링크 마이그레이션 실행 (migration-007)
- [ ] 10. 멀티테넌시 마이그레이션 실행 (migration-008) — 회사별 격리
- [ ] 11. 추천 적용 마이그레이션 실행 (migration-009) — AI 진단 → 사이트 반영
- [ ] 12. Email 로그인 활성화
- [ ] 13. Google OAuth 활성화
- [ ] 14. API 키 받기
- [ ] 15. 본인을 admin으로 승격

---

## 1. 프로젝트 생성

1. https://supabase.com 가입 (GitHub 로그인 추천)
2. **New project** 클릭
3. 설정:
   - Name: `modlai` (원하는 이름)
   - Database Password: 강한 비밀번호 (아무도 볼 수 없게, 1password 등에 저장)
   - Region: **Northeast Asia (Seoul)** ← 한국 서비스면 필수
   - Pricing Plan: **Free** (시작은 무료로 충분)
4. **Create new project** → 약 2분 대기

## 2. 스키마 SQL 실행

1. 좌측 메뉴 → **SQL Editor** → **New query**
2. `modlai/backend/supabase/schema.sql` 전체 내용 복사 → 붙여넣기
3. 우측 상단 **Run** (Ctrl/Cmd + Enter)
4. 성공하면 하단에 "Success. No rows returned" 표시

만약 에러 나면:
- "permission denied" → Supabase 대시보드에서 실행하는 게 맞는지 확인
- "relation already exists" → 이미 만든 상태, 무시하거나 `drop table` 후 재실행

## 3. Storage 버킷 SQL 실행

1. SQL Editor에서 새 쿼리 열기
2. `modlai/backend/supabase/schema-storage.sql` 전체 복사 → 실행
3. 좌측 메뉴 → **Storage** 에서 `generated-images`, `user-uploads` 두 버킷이 보이면 성공

## 4. 결제 PG 추상화 마이그레이션 실행

Stripe와 Balance를 스위치할 수 있게 하는 테이블들을 추가해요. **꼭 실행해야 합니다.**

1. SQL Editor에서 새 쿼리 열기
2. `apps/backend/supabase/migration-002-payment-providers.sql` 전체 복사 → 실행
3. 다음 테이블이 새로 생기면 성공:
   - `system_settings` (전역 설정, `active_payment_provider` 포함)
   - `credit_packages` (크레딧 패키지 카탈로그)
   - `admin_actions` (어드민 액션 감사 로그)

확인:
```sql
select * from public.credit_packages order by sort_order;
-- starter, pro, studio, enterprise_50k 4개 행이 나와야 함

select key, value from public.system_settings;
-- active_payment_provider = "stripe" 가 기본값
```

## 5. Fashion Model 고급 기능 마이그레이션 실행

Character sheet 기능을 위한 테이블들을 추가해요.

1. SQL Editor에서 새 쿼리 열기
2. `apps/backend/supabase/migration-003-advanced-fashion-models.sql` 전체 복사 → 실행
3. `fashion_models` 테이블에 컬럼들이 추가되고, `fashion_model_sheets` 테이블이 새로 생성됩니다

확인:
```sql
-- 컬럼 추가 확인
select column_name from information_schema.columns
 where table_name = 'fashion_models' and column_name in ('status','enriched_appearance','style_tags');

-- 새 테이블 확인
select count(*) from public.fashion_model_sheets;  -- 0 나오면 OK
```

## 6. Channel Publishing 마이그레이션 실행

Shopify / Faire 등 외부 플랫폼 연동을 위한 테이블들을 추가해요.

1. SQL Editor에서 새 쿼리 열기
2. `apps/backend/supabase/migration-004-channels.sql` 전체 복사 → 실행
3. 다음 테이블이 새로 생성됩니다:
   - `channel_connections` (사용자당 채널 연결)
   - `generation_commerce_meta` (상품별 가격/SKU/재고)
   - `publishings` (전송 이력)

확인:
```sql
select table_name from information_schema.tables
 where table_schema = 'public'
   and table_name in ('channel_connections','generation_commerce_meta','publishings');
-- 3개 나오면 OK
```

## 7. Insights & Analytics 마이그레이션 실행

스토어 데이터 동기화 + AI 진단을 위한 테이블들을 추가해요.

1. SQL Editor에서 새 쿼리 열기
2. `apps/backend/supabase/migration-005-insights.sql` 전체 복사 → 실행
3. 다음 테이블/뷰가 새로 생성됩니다:
   - `external_products`, `external_orders`, `external_order_items`, `external_customers`
   - `product_analytics_daily` (일별 집계)
   - `ai_diagnoses`, `ai_recommendations`
   - `sync_jobs` (sync 이력)
   - `buyer_profiles` (Phase 4용)
   - `product_performance` view (자동 집계)

확인:
```sql
select table_name from information_schema.tables
 where table_schema = 'public'
   and table_name like 'external_%';
-- 4개 나오면 OK

select count(*) from public.product_performance;  -- 0 나오면 OK (아직 데이터 없음)
```

## 8. Product Masters + Import 마이그레이션 실행

Excel/CSV 파일 import + 내부 상품 마스터를 위한 테이블을 추가해요.

1. SQL Editor에서 새 쿼리 열기
2. `apps/backend/supabase/migration-006-product-masters.sql` 전체 복사 → 실행
3. 다음 테이블/뷰가 새로 생성됩니다:
   - `product_masters` (내부 상품 마스터)
   - `product_master_variants` (사이즈/variants)
   - `import_jobs` (파일 업로드 이력)
   - `product_masters_full` view (자동 집계)

확인:
```sql
select count(*) from public.product_masters;  -- 0
select count(*) from public.import_jobs;      -- 0
```

## 9. 마스터 링크 마이그레이션 실행 (추천)

product_masters가 AI 이미지·publish 이력·진단·에러와 연결되도록 추가 테이블과 view를 만들어요. **중요 — 이걸 실행하지 않으면 Catalog 카드에서 publish 상태와 에러를 볼 수 없어요.**

1. SQL Editor 새 쿼리
2. `apps/backend/supabase/migration-007-master-linkages.sql` 전체 복사 → 실행
3. 생성되는 것:
   - `product_master_generations` (N:M: 마스터 ↔ AI 이미지)
   - `product_master_errors` (에러 로그)
   - `publishings.master_id`, `external_products.master_id`, `ai_diagnoses.master_id` 컬럼 추가
   - `product_masters_with_status` view (카드에 필요한 모든 정보 집계)
   - 자동 트리거 2개 (primary generation 동기화 + publish 에러 자동 로그)

확인:
```sql
select column_name from information_schema.columns
 where table_schema='public' and table_name='publishings' and column_name='master_id';
-- 1 row 나오면 OK

select * from public.product_masters_with_status limit 1;
-- 빈 결과 나와도 OK (아직 데이터 없음)
```

## 10. 멀티테넌시 마이그레이션 실행 (중요 — 회사별 격리)

조직/회사 단위로 데이터를 분리하는 테이블 + 모든 기존 테이블에 org_id 추가.

1. SQL Editor 새 쿼리
2. `apps/backend/supabase/migration-008-organizations.sql` 전체 복사 → 실행
3. 생성되는 것:
   - `organizations` — 회사(테넌트)
   - `organization_members` — 유저 ↔ 조직 링크 + 역할(owner/admin/member)
   - `organization_invitations` — 이메일 초대
   - 20+ 기존 테이블에 `org_id` 컬럼 추가
   - **RLS 전면 재작성** — 조직 멤버십 기반 접근 제어
   - `organizations_with_stats` view
   - `deduct_org_credits`, `add_org_credits` RPC (조직 공용 크레딧 풀)

확인:
```sql
select * from public.organizations;  -- 0 rows
select column_name from information_schema.columns
 where table_schema='public' and column_name='org_id';
-- 20+ rows (모든 데이터 테이블에 추가됨)
```

## 11. 추천 적용 마이그레이션 실행 (중요 — AI 진단 → 사이트 반영)

AI 진단 결과를 버튼 하나로 사이트에 적용할 수 있게 하는 테이블.

1. SQL Editor 새 쿼리
2. `apps/backend/supabase/migration-009-recommendation-applications.sql` 복사 → 실행
3. 생성되는 것:
   - `recommendation_applications` — 적용 이력 (before/after/push_status 기록)
   - `ai_diagnoses_with_apps` view — 어떤 추천이 이미 적용됐는지 표시
   - RLS 정책

확인:
```sql
select * from public.recommendation_applications;  -- 0 rows
```

## 12. Email 로그인 활성화

1. 좌측 메뉴 → **Authentication** → **Providers**
2. **Email** 설정:
   - ✅ Enable Email provider
   - ✅ Confirm email: 프로덕션은 ON, 개발은 편의상 OFF 가능
   - Secure email change: ON 권장
3. 저장

### (선택) 매직 링크만 쓰려면

Authentication → Settings → **Email Auth** → "Disable signup with passwords" 옵션.
MODLai는 둘 다 지원하니 그냥 두면 됩니다.

## 13. Google OAuth 활성화

1. **Google Cloud Console** (https://console.cloud.google.com) 접속
2. 프로젝트 없으면 새로 만들기 → **APIs & Services** → **Credentials**
3. **Create Credentials** → **OAuth client ID**
   - Application type: **Web application**
   - Name: `MODLai`
   - **Authorized redirect URIs**에 Supabase가 주는 URL 복붙
     - Supabase 대시보드 → Authentication → Providers → Google 옆의 "Callback URL (for OAuth)"
     - 예: `https://abcxyz.supabase.co/auth/v1/callback`
4. Client ID + Client Secret 복사
5. **Supabase 대시보드** → Authentication → Providers → **Google**
   - ✅ Enable
   - Client ID 붙여넣기
   - Client Secret 붙여넣기
   - Save

## 14. API 키 받기

좌측 메뉴 → **Project Settings** (톱니바퀴) → **API**

복사할 값:
- **Project URL**: `https://abcxyz.supabase.co` → `SUPABASE_URL`
- **anon public**: 긴 키 → `SUPABASE_ANON_KEY` (프론트에 노출 OK)
- **service_role**: 긴 키 → `SUPABASE_SERVICE_ROLE_KEY` (절대 프론트 노출 금지!)

백엔드 `.env.local`에 추가:
```env
SUPABASE_URL=https://abcxyz.supabase.co
SUPABASE_ANON_KEY=eyJhbGci...
SUPABASE_SERVICE_ROLE_KEY=eyJhbGci...
```

Vercel 배포한다면 같은 값을 Vercel 환경변수에도 추가.

## 15. 본인을 admin으로 승격

1. 먼저 로그인을 한 번 해서 `auth.users`에 본인 계정이 있어야 합니다
   - MODLai 프론트에서 로그인 (다음 단계에서 만들 예정)
   - 또는 Supabase 대시보드 → Authentication → Users → "Add user"
2. SQL Editor 열고 `make-admin.sql`의 이메일을 본인 걸로 바꾼 뒤 실행

```sql
update public.users set role = 'admin' where email = 'you@example.com';
```

## 🧪 확인

SQL Editor에서:
```sql
-- 테이블이 잘 만들어졌는지
select table_name from information_schema.tables
 where table_schema = 'public' order by table_name;

-- 내 admin 권한 확인
select id, email, role from public.users where role = 'admin';

-- RLS가 켜졌는지
select tablename, rowsecurity from pg_tables
 where schemaname = 'public' and tablename in ('users','generations');
-- rowsecurity가 t (true) 여야 정상
```

## 🛟 문제가 생기면

- **"새 사용자가 users 테이블에 안 생김"**: `handle_new_user` 트리거가 잘 붙었나 확인.
  `select * from pg_trigger where tgname = 'on_auth_user_created';`
- **"RLS 때문에 내가 내 데이터도 못 봄"**: 로그인이 안 된 상태일 수 있음. 로그인 후 재시도.
- **"schema.sql 중간에 실패"**: 에러 라인 확인 후 그 부분부터 다시 실행. idempotent하게 쓰려 했지만 혹시 모르면 처음부터 리셋 → `drop table public.users cascade;` 등.

---

다 끝나면 알려주세요! 다음은 **2단계: 백엔드에 Supabase 연결**입니다.
