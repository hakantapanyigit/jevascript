# jevascript.org — Landing Page Spesifikasyonu

Bu belge landing page için gerekenleri tanımlar: konumlandırma, sayfa yapısı, her bölümün
metin taslağı, gösterilecek örnekler ve bunların gerçek ölçüm değerleri, playground kararı,
görsel ihtiyaçları ve lansman kontrol listesi. Docs ayrı bir iş; burada yalnızca landing'in
docs'a nerede bağlanacağı yazıyor.

Sayfa dili İngilizce. Aşağıdaki metin taslakları sayfada göründüğü hâliyle İngilizce, açıklamalar
Türkçe.

---

## 1. Amaç ve hedef kitle

**Tek amaç:** Bir TypeScript geliştiricisi sayfayı 90 saniye okuyunca üç şeyi anlamalı:

1. Bu bir LLM SDK'sı değil; `is`, `score`, `choose` adında üç yeni **değer** veriyor.
2. Kararı model vermiyor; model anlamı puanlıyor, sonucu `if` belirliyor.
3. Kurup ilk sonucu almak beş satır.

**Hedef kitle, öncelik sırasıyla:**

- Ürün geliştiren TypeScript/Node ekipleri (support, moderasyon, fraud, satış, arama). Bugün bu
  işler için ya regex ya da pahalı generatif LLM çağrısı kullanıyorlar.
- Agent ve RAG altyapısı yazanlar (guardrail, routing, retrieval gate, bağlam budama).
- LLM çıktısını test etmek isteyenler (semantik assertion).

**Hedef kitle olmayanlar:** chatbot yapmak isteyenler, metin üretimi arayanlar. Sayfa bunu
açıkça söylemeli; yanlış kitleyi erken kaybetmek doğru kitleyi kazanmaktan ucuz.

---

## 2. Konumlandırma

**Kategori adı:** *semantic runtime* (LLM SDK değil, AI framework değil). Sayfada bu terim
tutarlı kullanılmalı; docs da aynı terimi kullanmalı.

**Tez cümlesi (sayfanın omurgası):**

> AI decides meaning. Your code decides consequences.

**Bir cümlelik tanım:**

> jevascript adds `is`, `score` and `choose` next to `string`, `number` and `boolean`, so
> judgements that don't come from a property can still be ordinary values in ordinary
> control flow.

**Ne olmadığı (sayfada açıkça):**

- Not an LLM SDK. There is no prompt, no completion, no generated text.
- Not an agent framework. It gives agents values to branch on; it does not run the loop.
- Not a security boundary. Auth, payment and compliance stay in deterministic code.

**Rakip/komşu konumlandırması:** Generatif LLM'ler cümle üretir; jevascript sayı üretir.
Embedding'ler benzerlik verir; jevascript yargı verir. Kural motorları olguya bakar; jevascript
anlama bakar. Bu üç karşıtlık bir bölüm olarak sayfada yer alabilir (bkz. §3.9).

**Tagline adayları** (hero altı, birini seç):

1. *Semantic values for deterministic TypeScript.* — mevcut README başlığı, en güvenli.
2. *Meaning as a value.* — en kısa, en iddialı.
3. *`if` on things that aren't in the data.* — geliştiriciye en çok hitap eden.

Öneri: 1 başlık, 3 alt başlık.

---

## 3. Sayfa yapısı ve metin taslakları

Sıra, okuyucunun soru sırasıdır: bu ne → nasıl görünüyor → neden ucuz → neden güvenli →
gerçekten çalışıyor mu → nasıl kurarım → nasıl test ederim → sınırları ne.

### 3.1 Hero

- **Headline:** Semantic values for deterministic TypeScript.
- **Subhead:** `is`, `score` and `choose`, next to `string`, `number` and `boolean`. The model
  supplies the judgement. Your code decides the consequence.
- **Install satırı** (kopyalanabilir): `npm install jevascript` — *paket adı lansmandan önce
  kesinleşmeli; bkz. §8.*
- **Kod bloğu** (hero'nun sağı ya da altı, syntax highlight, en fazla 8 satır):

```ts
import { semantic } from "jevascript"

const urgency = await semantic(ticket).score("A human needs to act on this urgently.")

if (urgency > 80) {
  pageOnCall()
}
```

- **CTA'lar:** `Get started` (docs quick start) ve `GitHub`. İkincil: `Try it` (playground,
  §5).
- **Hero altı güven satırı:** "Zero dependencies · Node 22+ · One request for any number of
  questions · MIT"

### 3.2 The three primitives

Üç kart, her biri tek satır kod ve dönüş tipi:

```ts
await semantic(ticket).is("This describes a security problem.")     // boolean
await semantic(ticket).score("The customer is frustrated.")         // number, 0–100
await semantic(ticket).choose(["billing", "technical", "sales"])    // "billing" | "technical" | "sales"
```

Kartların altına tek cümle: *`choose` infers the literal union. No `as const`, no schema.*

### 3.3 Ask everything at once

Batching, ürünün en ölçülebilir farkı. Gerçek ölçümle göster (canlı API, 7 soru, kısa ticket,
3 turun medyanı):

| | requests | tokens | latency |
|---|---|---|---|
| batched | 1 | 490 | 801 ms |
| sequential | 7 | 2 440 | 2 572 ms |

**5.0× cheaper, 3.2× faster.** State büyüdükçe fark tam N×'e yaklaşır, çünkü sıralı çağrı
state'i her seferinde yeniden gönderir.

Kod:

```ts
const t = await semantic(ticket).batch({
  urgency: score("A human needs to act on this urgently."),
  frustration: score("The person writing this is frustrated or angry."),
  security: is("This describes a security or access-control problem."),
  team: choose(["billing", "technical", "security"]),
})
```

Alt not: *Questions created in the same turn travel in one request. `Promise.all` batches
identically.*

### 3.4 Consequences are plain code

Tezin görsel karşılığı. İki sütun: solda semantik değerler, sağda düz TypeScript.

```ts
const priority =
  t.urgency >= 80 || t.frustration >= 90 ? "critical" : "normal"

if (priority === "critical" && customer.plan !== "free") pageOnCall()
if (t.security) notifySecurity()
```

Metin: *Thresholds, weights and actions live in code you can diff, test and review. Nothing
here is a prompt.*

### 3.5 Things ordinary code cannot do

Sayfanın "gerçekten çalışıyor mu" bölümü. Bir grid; her hücre bir soru, iki girdi ve canlı
API'den ölçülmüş olasılıklar. Sayılar gerçek; sayfada "measured against the live API" notu
olmalı. Kaynak: `examples/impossible-in-code.ts`.

| Soru | Girdi | p |
|---|---|---|
| This review comment is passive-aggressive. | "Nice work! Could you add a test for the empty case?" | 0.15 |
| | "Interesting choice. I'm sure you had your reasons for not testing this." | 0.92 |
| The star rating contradicts the text. | 5★ "Works exactly as advertised." | 0.03 |
| | 5★ "Arrived broken, support never replied." | 0.91 |
| These two reports describe the same bug. | "Login button does nothing on Safari" ↔ "Can't sign in from my Mac, clicking submit has no effect" | 0.88 |
| | "Login button does nothing on Safari" ↔ "Password reset email never arrives" | 0.21 |
| This report lists the steps to reproduce. | "It crashes. Please fix." | 0.02 |
| | "Open /settings, toggle 'beta features' twice quickly, page goes white." | 0.94 |
| The comment accurately describes the code. | `// Retries up to 3 times…` + retry loop | 0.89 |
| | `// Retries up to 3 times…` + `return await call()` | 0.03 |
| The translation preserves how tentative the source is. | EN → TR, hedge korunmuş | 0.91 |
| | EN → TR, hedge silinmiş | 0.05 |
| Someone needs to act on this right now. (score) | "hey, quick one — is there a dark mode?" | 15 |
| | "We've been down for 40 minutes and I have the CEO on the phone." | 91 |

Her hücrede kod tek satır olmalı (`semantic({ body }).is("...")`). Bu bölümün başlığı:
*Not "annoying to write". Not expressible.*

### 3.6 One shared file

Uygulamada nasıl kurulduğu. Kısa, iki blok:

```ts
// lib/semantic.ts
import { createSemantic, jev } from "jevascript"

export const semantic = createSemantic({
  provider: jev(),                      // JEV_API_KEY from the environment
  defaults: { timeoutMs: 5_000, cache: "10m" },
})
```

```ts
// anywhere
import { semantic } from "./lib/semantic"
```

Metin: *Same call sites as the quick start. One import line apart.*

### 3.7 Test without a model

```ts
import { createMockSemanticProvider } from "jevascript/testing"

semantic.configure({ provider: createMockSemanticProvider({ urgently: 0.9, team: "billing" }) })
```

Metin: *Rules match substrings of the question, so a stub survives rewording. The whole
suite runs offline.*

### 3.8 Honest about uncertainty

Ürünün güven veren bölümü. Üç kısa madde, her biri bir kod satırıyla:

- **Bands beat thresholds.** `is("...", { allowUnknown: true })` → `true | false | "unknown"`.
  Orta bant tahmin edilmez, insana düşer.
- **Confidence is measured, never invented.** `{ minConfidence: 0.8 }` soruyu yeniden sorar ve
  cevabın ne kadar oynadığını ölçer. Olasılıktan türetilmiş sahte bir güven yoktur.
- **Not a security boundary.** Prompt injection ölçüldü: talimat tipi saldırılar çalışmaz
  (0.04–0.17), içerik tipi saldırılar çalışır (0.78). Savunma, yazarın cevabın otoritesi olduğu
  soruları sormak ve önüne deterministik kapı koymaktır. Bu tabloyu sayfaya koymak cesaret ister
  ama tam da bu yüzden güven verir.

### 3.9 What it is not

Üç sütunlu karşılaştırma. Başlık: *Where it sits.*

| | Generative LLM | Embeddings | Rules engine | jevascript |
|---|---|---|---|---|
| Output | text | vector | boolean | probability-backed value |
| Reads meaning | yes | similarity only | no | yes |
| Deterministic consequence | no | n/a | yes | yes (in your code) |
| Cost per decision | high | low | zero | fraction of a cent |
| Testable offline | hard | yes | yes | yes |

Alt not, gerçek maliyet: *A seven-question triage on a support ticket: 1 request, 633 tokens,
$0.000027.*

### 3.10 Providers

Kısa. *Jev (TypeSafe's System One decision model) is the first provider. The provider
interface is public and multi-question by construction; the public API never names a vendor.*
Docs'a link: "Write a provider".

### 3.11 Footer

Docs · GitHub · npm · Changelog · License (MIT) · "Built with Jev" (TypeSafe'e link,
sayfa üstünde değil, altta).

---

## 4. Örnek stratejisi

Sayfada üç seviye örnek olmalı; hepsi repoda çalışır hâlde ve canlı API'ye karşı doğrulanmış:

1. **On satırlık örnekler** (`examples/quick/`): hero ve primitives bölümleri buradan beslenir.
   `urgent`, `triage`, `same-bug`, `rank`.
2. **"Impossible in code" grid'i** (`examples/impossible-in-code.ts`): §3.5.
3. **Senaryo sayfaları** (docs'ta, landing'den link): ticket triage, lead qualification,
   moderation, RAG gate, agent guardrail, fraud review. Her biri `examples/launch/` ve kök
   `examples/` altındaki dosyalara karşılık gelir.

**Örnek yazım kuralları** (sayfadaki her kod bloğu için zorunlu):

- Kriterler **önerme** olarak yazılır, etiket değil. "urgency" değil, "A human needs to act on
  this urgently." Ölçüm: etiket biçimi 0.54 verdi, önerme 0.06.
- Sorular metinde gözlemlenebilir şeyler hakkındadır, gelecek hakkında değil. "Will retrying
  work?" değil, "This error was caused by something the caller sent."
- Tek adımlı sorular. "Is the task complete?" 0.24 verdi; alt hedef başına tek soru 0.95/0.98.
- Deterministik olan (tarih, tutar, mesafe, plan) kodda kalır; kod bloklarında bu ayrım
  görünür olmalı.
- Vendor adı API'de geçmez. `jev()` yalnızca provider satırında görünür.
- Tek kurgusal domain: Northwind, bir B2B ödeme API'si. Tüm örnekler aynı evrende.

---

## 5. Playground kararı

Canlı bir playground, siteye giren herkesin sizin anahtarınızla ücretli çağrı yapması demek.
İki seçenek:

**A. Kayıtlı tekrar (önerilen, lansman için).** Örnekler bir kez canlı çalıştırılır, sonuçlar
JSON olarak kaydedilir, site bunları oynatır. Sıfır anahtar riski, sıfır maliyet, sıfır
gecikme. Kullanıcı kendi girdisini yazamaz; bunun için "run it locally" komutu gösterilir.
Sayfada "recorded results" etiketi dürüstçe yazılmalı.

**B. Oran sınırlı proxy.** Küçük bir Worker, IP başına günde N istek, girdi 2 KB ile sınırlı,
yalnızca `is`/`score`/`choose`. Kullanıcı kendi cümlesini deneyebilir; bu, ürünü satan şey.
Maliyet istek başına yaklaşık üç binde bir sent, günde bin deneme yaklaşık 3 sent. Risk düşük,
ama kötüye kullanım için kota ve Turnstile gerekir.

Öneri: A ile lansman, B'yi bir hafta sonra ekle. Playground'da gösterilecek şey, her yargı için
görülen değer, olasılık dağılımı ve seçilen dal (decision trace). Bu görsel, kütüphanenin
"olasılık bir değerdir" tezini tek bakışta anlatır.

---

## 6. Görsel ve varlık listesi

- **Logo ve wordmark.** Küçük harf `jevascript`. Sembol önerisi: `is` harflerinin ya da bir
  olasılık çubuğunun soyutlaması. JavaScript sarısından uzak durulmalı; karışıklık davet eder.
- **OG görseli** (1200×630): tez cümlesi + beş satırlık kod.
- **Decision trace görseli:** bir ticket, dört soru, dört olasılık çubuğu, altında düz
  TypeScript `if`. Hero'nun alternatifi ya da §3.4'ün görseli.
- **Benchmark grafiği:** §3.3 tablosunun bar chart hâli; iki çubuk, üç metrik.
- **Kod blokları:** tek tema, açık ve koyu mod, satır numarası yok, kopyala düğmesi var.
- **Favicon.**

---

## 7. Teknik gereksinimler

- **Statik site.** Astro ya da Next static export; Cloudflare Pages ya da Vercel. Landing'in
  sunucu tarafı ihtiyacı yok (playground B seçilirse ayrı Worker).
- **Docs:** `jevascript.org/docs` altında, aynı repo, aynı tasarım dili. Landing'deki her
  kod bloğu docs'ta bir sayfaya link vermeli.
- **SEO:** başlık "jevascript — semantic values for TypeScript". Anahtar terimler: semantic
  runtime, decision model, LLM classification TypeScript, semantic boolean, Jev. `javascript`
  kelimesiyle karışma riski var; meta description'da "not JavaScript" demeye gerek yok ama
  wordmark her yerde `jevascript` küçük harf ve tek biçimli olmalı.
- **Analytics:** gizlilik dostu (Plausible ya da Cloudflare Web Analytics). Ölçülecek üç olay:
  install komutu kopyalama, playground çalıştırma, docs'a geçiş.
- **Performans:** JS'siz okunabilir olmalı; kod blokları build zamanında highlight edilir.
- **npm badge** ve sürüm numarası otomatik çekilir.

---

## 8. Lansmandan önce karara bağlanacaklar

1. **npm paket adı.** Sayfa `npm install jevascript` gösterecekse bu ad npm'de alınabilmeli;
   `javascript` paketine benzerlik nedeniyle reddedilirse scope'lu ad ya da farklı ad gerekir.
   Karar verilmeden sayfa yayınlanmamalı; install komutu sayfanın en çok kopyalanan satırı.
2. **Sürüm.** `0.1.0` ile "working MVP" etiketi mi, `1.0.0` mı? Sayfa "Status" satırında
   dürüst olmalı. Öneri: 0.x ve "API may change before 1.0".
3. **Playground A/B** (§5).
4. **Docs asgari kapsamı:** Quick start, Primitives, Batching, Definitions (`defineSchema`,
   `defineMetric`, `defineRule`), Collections, Uncertainty (bands, confidence), Testing,
   Providers, Next.js notu (`serverExternalPackages`), Not a security boundary. Landing bu on
   sayfaya link verir; bunlar olmadan CTA boşa gider.

---

## 9. Metin tonu

- Kısa cümleler, iddia ve ölçüm yan yana. Her "faster", "cheaper", "works" bir sayıyla gelir.
- Abartı yok. "AI-powered" yazılmaz; sayfada "AI" kelimesi yalnızca tez cümlesinde geçer.
- Sınırlar gizlenmez; §3.8 sayfanın ortasında, dipnotta değil.
- Vendor adı yalnızca §3.10 ve footer'da.

---

## 10. Lansman kontrol listesi

- [ ] Paket adı kesin, npm'de yayınlanmış, `npm install` satırı doğrulanmış
- [ ] Hero kodu gerçekten çalışıyor (kopyala-yapıştır testi, temiz projede)
- [ ] §3.3 ve §3.5 sayıları son sürümle yeniden ölçülmüş ve tarihlenmiş
- [ ] Her kod bloğu docs'ta bir sayfaya link veriyor
- [ ] OG görseli, favicon, logo
- [ ] Açık/koyu mod
- [ ] Playground kayıtları üretilmiş (A) ya da Worker kotası ayarlanmış (B)
- [ ] `robots.txt`, sitemap, canonical URL
- [ ] 404 sayfası
- [ ] Mobilde kod blokları yatay kaydırılabiliyor
- [ ] Analytics olayları çalışıyor
- [ ] GitHub README ile landing aynı tez cümlesini ve aynı sayıları kullanıyor
