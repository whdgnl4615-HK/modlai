# Fashion Models

가상 모델을 저장해서 여러 이미지 생성에 일관되게 재사용하는 기능입니다. AI 이미지 생성의 가장 큰 문제 중 하나 — **"같은 모델로 생성한다 했는데 매번 얼굴이 다름"** — 을 해결해요.

## 핵심 개념 — Character Sheet

모델을 처음 저장할 때, 시스템이 자동으로 **여러 앵글의 레퍼런스 이미지 세트**(character sheet)를 생성합니다:

- 정면 (front)
- 3/4 각도 (three_quarter)
- 측면 (side)
- 전신 (full_body)

이 4장은 Supabase Storage에 영구 저장되고, 이후 이 모델로 이미지를 생성할 때마다 **자동으로 레퍼런스에 주입**돼요. AI 모델은 이 레퍼런스를 보고 얼굴/체형을 일관되게 유지합니다.

## 동작 플로우

```
사용자가 "새 모델" 클릭
        │
        ▼
┌───────────────────────────────────┐
│  Modal: 정보 입력                  │
│  - 이름 (required)                 │
│  - 외형 묘사 (required)             │
│    [✦ AI로 상세하게] 버튼          │
│    → Claude가 상세 묘사로 확장     │
│  - 나이 / 성별 / 키               │
│  - 민족 / 스타일 태그              │
│  - 레퍼런스 사진 (선택)            │
└───────────┬───────────────────────┘
            │ [모델 저장 + 시트 생성]
            ▼
  POST /api/models            (DB row 생성)
            │
            ▼
  POST /api/models/:id/generate-sheet
            │
            ▼
┌──────────────────────────────────┐
│  Step 1: Claude enrichment       │
│    짧은 묘사 → 풍부한 시각 묘사  │
├──────────────────────────────────┤
│  Step 2: Nano Banana 순차 생성   │
│    1. front (from ref photo)     │
│    2. three_quarter (from front) │ ← 이전 이미지를
│    3. side (from front)          │   seed로 써서
│    4. full_body (from front)     │   얼굴 일관성
├──────────────────────────────────┤
│  Step 3: Supabase Storage 업로드 │
├──────────────────────────────────┤
│  Step 4: fashion_model_sheets    │
│          rows insert             │
├──────────────────────────────────┤
│  Step 5: fashion_models.status   │
│          = 'ready'               │
└──────────────────────────────────┘
            │
            ▼
  Library에 모델 카드 표시 (✓ 4 sheets)
            │
            ▼
사용자가 "사용하기" 클릭
            │
            ▼
Generate 화면에서 옷 사진 + 프롬프트 입력
            │
            ▼
  POST /api/generate/nanobanana
  body: { ..., fashionModelId: 'xyz' }
            │
            ▼
  백엔드가 자동으로:
    - sheets 이미지 4장을 refImages에 추가
    - 프롬프트에 identity 묘사 prepend
            │
            ▼
  AI가 일관된 얼굴로 이미지 생성 ✨
```

## 비용

| 항목 | 크레딧 |
|---|---|
| 모델 저장 자체 | 0 (DB row만 생성) |
| Character sheet 생성 (4장) | 120 (30 × 4) |
| 이후 생성 때 sheet 재사용 | 0 (무료) |

4장 중 일부만 성공해도 성공한 만큼만 차감 (실패 분은 자동 환불).

## 데이터 모델

### `fashion_models` 테이블
```sql
id, user_id, name, appearance,
enriched_appearance,          -- Claude가 확장한 풍부한 묘사
age_range, gender, ethnicity, height_cm,
style_tags[], languages[],
ref_image_url,                -- 사용자 업로드 사진
primary_sheet_image_url,      -- 첫 시트 이미지 (카드에 표시)
status,                       -- draft | generating_sheet | ready | failed
is_archived, created_at, updated_at
```

### `fashion_model_sheets` 테이블
```sql
id, fashion_model_id, user_id,
angle,                        -- front | three_quarter | side | back | full_body | portrait
image_url, thumb_url,
model_key,                    -- which AI generated it (usually 'nanobanana')
cost, is_primary, sort_order
```

## API 레퍼런스

### `GET /api/models`
사용자의 모델 목록 (archived 제외)
```json
{ "models": [{ id, name, status, sheet_count, use_count, ... }] }
```

### `POST /api/models`
새 모델 생성 (시트 없음, draft 상태)
```json
// Request
{
  "name": "Aria",
  "appearance": "long wavy black hair, brown eyes",
  "ageRange": "20s",
  "gender": "female",
  "ethnicity": "Korean",
  "heightCm": 165,
  "styleTags": ["minimalist", "streetwear"],
  "refImage": "data:image/jpeg;base64,..."    // optional
}

// Response
{ "model": { ...row } }
```

### `POST /api/models/:id/generate-sheet`
Character sheet 생성. 동기 호출 (30-120초 소요).
```json
// Request (optional)
{ "angles": ["front", "three_quarter", "side", "full_body"] }

// Response
{ "ok": true, "sheets": [...], "cost": 120 }
```

### `GET /api/models/:id`
```json
{ "model": {...}, "sheets": [{...}] }
```

### `PATCH /api/models/:id`
필드 수정 (시트는 재생성 안 됨)

### `DELETE /api/models/:id`
Soft delete (archived = true)

## 모델 사용 주의점

### AI 모델별 sheet 활용 방식

| AI | 방식 |
|---|---|
| **Nano Banana** (최고) | 모든 sheet 이미지를 refImages에 주입 — 얼굴 일관성 최상 |
| **OpenAI gpt-image-1** | edit 모드로 sheets + 옷 이미지 모두 input — 일관성 좋음 |
| **Stability Ultra** | Front sheet를 structure control에 사용 + 프롬프트에 묘사 주입 — 일관성 중간 |

**추천**: Fashion Model 기능은 Nano Banana와 가장 궁합이 좋아요. 일관성이 중요한 생성은 Nano Banana로.

### 언제 시트를 재생성할까?

- 모델 묘사를 크게 바꿨을 때 (PATCH 후 `generate-sheet` 재호출)
- 첫 시트가 마음에 안 들 때
- 새 앵글을 추가하고 싶을 때 (`angles: ['back', 'portrait']` 넘겨서 추가 생성)

재호출하면 기존 시트는 모두 삭제되고 새로 생성돼요.

### 주의: refImage 업로드

사용자가 레퍼런스 사진을 올리면 `user-uploads` 버킷 (private)에 저장됩니다. 이 사진을 seed로 첫 시트가 만들어지고, 이후 시트들은 첫 시트를 seed로 사용합니다. 즉 **사용자가 올린 사진과 완전히 같은 사람이 생성되지는 않음** — AI 생성물 특성상 "비슷한 사람"이 나옵니다.

100% 같은 사람을 유지하려면 LoRA 파인튜닝 등 추가 기법이 필요합니다 (향후 과제).

## 향후 개선 가능

- **사용자 LoRA 파인튜닝 연동** — Replicate/Modal로 실제 인물 학습 (월 $5~)
- **더 많은 앵글** — back, portrait, smile, serious 등
- **옷 standalone 생성** — 모델 없이 제품만 찍는 모드
- **모델별 사용 통계** — 어떤 모델이 가장 많이 쓰이는지
- **모델 공유** — 팀 워크스페이스에서 공유
