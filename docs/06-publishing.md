# Publishing to Channels (Shopify + Faire)

MODLai이 생성한 이미지 + 상품 설명을 외부 e-commerce 플랫폼에 바로 푸시하는 기능입니다.

## 지원 채널

| 채널 | 타입 | 난이도 | 상태 |
|---|---|---|---|
| **Shopify** | B2C (D2C 스토어) | ⭐⭐ 쉬움 | ✅ 완전 구현 |
| **Faire** | B2B (도매 마켓플레이스) | ⭐⭐⭐ 중간 | ✅ 구현 (API 스펙 일부 추정) |
| Magento | B2C | ⭐⭐⭐ 중간 | 🚧 향후 추가 (같은 인터페이스) |
| FashionGo | B2B | ⭐⭐⭐⭐ 어려움 | 🚧 향후 추가 (API 접근 협의 필요) |

## 핵심 개념

### PublishChannel 추상화

PaymentProvider와 같은 패턴 — 각 채널이 공통 인터페이스 구현:

```
PublishChannel (abstract)
├── testConnection()  — 자격증명 검증
├── preview()         — 매핑된 payload 생성 (전송 안 함)
├── publish()         — 실제 전송
└── unpublish()       — 숨김/아카이브
```

새 채널 추가 시 어댑터 파일 하나만 추가하면 됩니다. 프론트엔드는 전혀 안 바뀜.

### CanonicalProduct

플랫폼 독립적인 중간 형식. DB의 여러 테이블에서 조합됩니다:

```
generations           ┐
generation_results    │── buildCanonicalProduct() ──> CanonicalProduct
descriptions          │
generation_commerce_meta ┘
```

각 채널 어댑터가 CanonicalProduct → 플랫폼 형식으로 매핑합니다.

## 데이터 매핑

| MODLai | Shopify | Faire |
|---|---|---|
| `title` | `product.title` | `name` |
| `description` + `highlights` + `stylingTips` | `body_html` (HTML) | `description` (plain text) |
| `tags[]` | `product.tags` (CSV) | 생략 |
| `seo_title/description` | metafields | 생략 |
| `imageUrls[]` | `images[].src` | `images[].url` |
| `retailPriceCents` | `variants[].price` ("45.00") | `retail_price.amount_minor` |
| `wholesalePriceCents` | 생략 | `wholesale_price.amount_minor` **필수** |
| `sku` | `variants[].sku` | `variants[].sku` **필수** |
| `inventoryQty` | `variants[].inventory_quantity` | `variants[].available_quantity` |
| `categoryByChannel.shopify` | `product_type` | — |
| `categoryByChannel.faire` | — | `taxonomy_type` **필수, 변경불가** |

## UX 흐름

사용자는 **각 플랫폼마다 하나씩 검토 후 푸시**합니다:

```
1. Generate 결과 카드에서 🔼 Publish 버튼 클릭
     ↓
2. Publish 모달 열림 [Shopify 탭] [Faire 탭]
     ↓
3. 연결 상태 확인 — 미연결이면 [연결하기] 클릭하여 토큰 입력
     ↓
4. Commerce 필드 입력 (SKU, 가격, 재고)
     ↓
5. Diff 뷰에서 좌: MODLai 원본 / 우: 플랫폼 형식 비교
     ↓
6. 경고/에러 메시지 확인 (에러 있으면 Publish 버튼 비활성화)
     ↓
7. [Publish →] 클릭 → 확인 다이얼로그 → 실제 전송
     ↓
8. 성공 시 플랫폼 관리 페이지 링크 제공
     ↓
9. 다른 탭(Faire)으로 전환해서 같은 생성물 B2B 포맷으로 재푸시 가능
```

**중요**: 상품은 항상 **draft/unpublished** 상태로 전송됩니다. 플랫폼 관리자 페이지에서 최종 검토 후 활성화하세요. 실수 방지.

## 채널별 설정 가이드

### Shopify

#### 1. Custom App에서 Access Token 받기

1. Shopify Admin → **Settings** → **Apps and sales channels**
2. **Develop apps for your store** → **Create an app**
3. App name: "MODLai Integration"
4. **Configure Admin API scopes**:
   - `write_products` (상품 생성)
   - `read_products` (확인용)
   - `write_inventory` (재고 업데이트)
5. **Install app** → **Admin API access token** 복사 (한 번만 표시됨!)
6. Store URL 확인 — 예: `mystore.myshopify.com`

#### 2. MODLai에서 연결

1. Publish 모달에서 [⚙ 채널 연결 설정] 클릭
2. 채널: Shopify 선택
3. Store URL: `mystore.myshopify.com` (https:// 제외)
4. Access Token: 방금 복사한 `shpat_...` 값
5. [연결 테스트 + 저장]

#### 3. 첫 Publish

상품은 `status: 'draft'`로 전송됩니다. Shopify Admin에서 **Products** 메뉴 → draft 상품 확인 → 필요하면 수정 → **Active**로 변경하면 스토어에 공개됩니다.

### Faire

#### 1. Brand 승인 받기

1. https://www.faire.com 에서 **Sell on Faire** → brand 지원
2. 심사 통과 (카탈로그 평가, 보통 1-2주)
3. 승인 후 브랜드 대시보드 접근 가능

#### 2. API Token 요청

공개 API 문서가 없어서 **이메일로 요청**해야 합니다:

- 받는이: `integrations.support@faire.com`
- 내용 예시:
  > Subject: API access request for brand integration
  >
  > Hi Faire team,
  > We're a brand (Brand ID: `brd_xxx`) looking to integrate our product catalog via API.
  > Could you please provide API access token + documentation?
  > Use case: Auto-publish new products from our design tool.
  >
  > Thanks!

보통 며칠 내 답변. Brand ID + Access Token + API 문서 링크를 받게 됩니다.

#### 3. MODLai에서 연결

1. Publish 모달 → [⚙ 채널 연결 설정]
2. 채널: Faire 선택
3. Access Token: 받은 토큰 붙여넣기
4. Faire Brand ID: `brd_...` 형식
5. [연결 테스트 + 저장]

#### 4. Faire 상품 필수 요건

| 필드 | 설명 |
|---|---|
| `wholesale_price` | 도매가 (필수) |
| `retail_price` | MSRP (필수) |
| `sku` | 모든 variant별로 고유 SKU |
| `taxonomy_type` | 카테고리 (예: `apparel-women`) **한 번 설정하면 변경 불가** |
| 이미지 | 공개 HTTPS URL만. Data URL 불가 |
| 최대 가격 | $1000 |

#### ⚠️ API 스펙 확정 체크리스트

`balance-provider.js`와 마찬가지로 `faire-channel.js`에 `TODO:DOC-CONFIRM` 주석이 있습니다. Faire 공식 문서 받으면 확인:

- [ ] `API_BASE` — `https://www.faire.com/external-api/v2` 가 맞는지
- [ ] 인증 헤더 — `X-FAIRE-ACCESS-TOKEN` 가 맞는지
- [ ] 상품 생성 엔드포인트 — `/products` vs `/brands/{id}/products`
- [ ] 응답 shape — `res.product` vs `res` 직접
- [ ] 가격 필드명 — `wholesale_price.amount_minor` 가 맞는지
- [ ] Taxonomy 키 — 위 `FAIRE_TAXONOMY` 상수의 키 포맷

각각 한 줄씩 수정하면 끝입니다. 전체 로직은 그대로 유지됩니다.

## Commerce 필드 — MODLai에 없는 것들

MODLai는 AI로 이미지/설명을 만들지만, 아래 정보는 **직접 입력** 필요:

- **SKU** — 상품 고유 코드 (권장: 브랜드-카테고리-순번, 예: `MDL-TEE-001`)
- **소매가** (retail) — 소비자가
- **도매가** (wholesale) — Faire용 (보통 소매가의 50%)
- **재고 수량** — 변형(사이즈/색상)별 or 총합
- **카테고리** — 각 채널의 분류 체계에 맞게
- **Variants** (선택) — 사이즈/색상 조합

Publish 모달의 Commerce form에서 입력하고, 저장하면 `generation_commerce_meta` 테이블에 영구 보관됩니다.

## 이미지 요구사항

**중요**: 모든 채널이 **공개 HTTPS URL**만 받습니다. 현재 MODLai는 AI 이미지를 data URL로 반환하기 때문에, publish 전에 Supabase Storage로 업로드해야 합니다.

- 백엔드: `uploadGeneratedImage()` 함수 이미 존재 (`_lib/utils.js`)
- Generate 엔드포인트에서 결과를 Storage에 업로드하도록 변경 필요
- 또는 Publish 시점에 data URL → Storage 업로드 후 publish

## 데이터베이스 테이블

### `channel_connections`
사용자당 채널당 1행. API 토큰 저장.
```sql
id, user_id, channel, status,
store_url, store_name, access_token, meta,
last_error, connected_at, updated_at
```

### `generation_commerce_meta`
생성물당 1행. 가격/SKU/변형 등 commerce 정보.
```sql
generation_id, user_id,
sku, retail_price_cents, wholesale_price_cents, currency,
inventory_qty, variants, channel_categories, image_urls,
weight_grams, hs_code, country_of_origin
```

### `publishings`
(generation_id, channel)당 1행. 전송 이력.
```sql
id, user_id, generation_id, channel,
status, external_product_id, external_url,
mapped_payload, response_payload,
error_message, published_at
```

## 재전송 & 업데이트

현재 `publish()`는 **항상 새 상품을 생성**합니다. 수정 시나리오:

- **수정 재전송**: 채널에서 직접 수정 (권장) — MODLai는 초기 seed 역할만
- **완전 교체**: Publish 다시 = 새 product 생성 (기존 상품은 채널에 남아있음)

향후 `updatePublished()` 메서드 추가 가능.

## 향후 추가될 채널

### Magento
- REST API 구조가 Shopify와 유사
- OAuth 1.0a 기반 인증
- 반나절 작업으로 추가 가능

### FashionGo
- 공식 API 없음 → 3가지 옵션:
  1. Syncware/ConnectPointz 같은 미들웨어 경유
  2. FashionGo와 파트너십 협의 (대량 판매자만)
  3. **CSV 내보내기** — Claude로 상품을 FashionGo 업로드 CSV 포맷으로 변환 → 사용자가 수동 업로드
  
옵션 3이 현실적으로 가장 빠름.

## 문제 해결

**"Validation failed: Wholesale price is required"**
→ Commerce form에서 도매가 입력. Faire 전송에만 필요.

**"Image is a data URL — Shopify needs public HTTPS URLs"**
→ Supabase Storage에 이미지 업로드 후 재시도. (Generate 엔드포인트가 아직 Storage 연동 안 된 경우 발생)

**"connection_failed"**
→ Access token 만료 또는 scope 부족. Shopify는 app에서 재생성, Faire는 support에 문의.

**"Publish 성공했는데 스토어에 안 보여요"**
→ 상품은 draft 상태로 생성됩니다. Shopify Admin/Faire Brand Portal에서 Active로 변경하세요.
