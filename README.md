# Supabase → GitHub JSON Cron Sync

定時把 Supabase 資料表匯出成 Git 倉庫裡的 JSON，作為離線備份 / 可版本化快照。

---

## 運作原理

```
┌─────────────────┐     cron / manual / dispatch      ┌──────────────────────┐
│  GitHub Actions │ ────────────────────────────────► │  hourly-sync.yml     │
│  Scheduler      │                                   │  (ubuntu + Node 20)  │
└─────────────────┘                                   └──────────┬───────────┘
                                                                 │
                                                                 ▼
                                                      ┌──────────────────────┐
                                                      │ sync-supabase-       │
                                                      │ tables.mjs           │
                                                      └──────────┬───────────┘
                                                                 │
         ┌───────────────────────────┬───────────────────────────┼────────────────┐
         ▼                           ▼                           ▼                ▼
  ⓪ routine 奇偶切換          ① 發現要匯出的表           ② 分頁拉取          ③ 脫敏寫檔
  奇數時 INSERT 標記列        service_role / 清單         PostgREST Range     data/*.json
  偶數時 DELETE 標記列                                   並行 + 重試          _manifest.json
                                                                 │
                                                                 ▼
                                                      ④ git commit + push
                                                         (僅在內容有變時)
```

### ⓪ Routine 奇偶小時切換

依 **Asia/Taipei** 的當地小時（可用 `ROUTINE_TZ` 改）：

| 小時 | 行為 |
|------|------|
| **奇數**（1, 3, 5, …, 23） | 向 `routine` 表 **INSERT** 一筆標記列 |
| **偶數**（0, 2, 4, …, 22） | **DELETE** 先前由 cron 新增的標記列 |

標記列特徵（只會刪這些，不動你的真實資料）：

- `name`：`[cron] odd-hour`（可調 `ROUTINE_MARKER_NAME`）
- `note`：以 `GH_CRON_ROUTINE` 開頭（可調 `ROUTINE_MARKER_NOTE`），後接當地時間戳

需要 **service role**（或 RLS 允許 insert/delete）。  
關閉：`ROUTINE_TOGGLE=0`。

### ① 表發現（Discovery）

| 條件 | 行為 |
|------|------|
| 有 `SUPABASE_SERVICE_ROLE_KEY` | 呼叫 `GET /rest/v1/`（`Accept: application/openapi+json`），從 OpenAPI paths 自動列出所有表（略過 `rpc/*` 與 path 參數） |
| 只有 anon key | 必須設定 `SUPABASE_TABLES`（逗號分隔），只匯出清單內的表 |

Service role 會繞過 RLS，因此能完整備份；anon 只能讀到政策允許的列。

### ② 分頁拉取（PostgREST）

- 對每張表：`GET /rest/v1/{table}?select=*`
- 用 HTTP `Range: from-to` 分頁（預設每頁 1000 列），直到回傳少於 page size
- **多表並行**（預設 concurrency = 4），縮短總同步時間
- **指數退避重試**（429 / 5xx / 網路錯誤），預設最多 3 次

### ③ 脫敏與寫入

- 欄位名像 `password`、`api_key`、`token`、`secret`… → 整欄改為 `[REDACTED SECRET]`
- 字串內容若像 OpenAI `sk-…`、JWT `eyJ…` 等 → 就地遮罩
- 若有 `id` / `uuid` / `created_at` 會排序，讓 git diff 更穩定
- **內容未變則不覆寫檔案**，減少無意義 commit 噪音
- 已刪除的表對應 JSON 會被 prune
- `data/_manifest.json` 記錄同步時間、表數、列數、失敗項

### ④ 提交

Workflow 只 `git add data`；若 staging 無差異就跳過 commit/push。  
`concurrency.group` 確保同時間只有一條 sync pipeline 在推送，避免 race。

### 觸發來源（三重保險）

| 觸發 | 說明 |
|------|------|
| `schedule` | 每小時 UTC `:37` 與 `:57`（雙 slot，降低 GitHub 跳過排程的風險） |
| `workflow_dispatch` | Actions 頁面手動跑 |
| `repository_dispatch` (`external-sync`) | 外部 cron（如 cron-job.org）呼叫 GitHub API 當備援 |

---

## 目錄結構

```
.
├── .github/workflows/hourly-sync.yml   # 排程與 CI 流程
├── scripts/sync-supabase-tables.mjs    # 核心同步邏輯（零 npm 依賴）
├── data/
│   ├── _manifest.json                  # 同步中繼資料
│   └── {table}.json                    # 各表完整匯出
└── README.md
```

---

## 必要 GitHub Secrets

| Secret | 用途 |
|--------|------|
| `SUPABASE_URL` | 專案 URL，例如 `https://xxxx.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | **建議**：自動發現並匯出全部表 |
| `SUPABASE_ANON_KEY` | 僅 anon 時使用（需搭配 `SUPABASE_TABLES`） |
| `SUPABASE_TABLES` | 逗號分隔表名，例如 `article,bank,music` |

> 金鑰只放 Secrets，**不要**寫進 repo。

### 選用環境變數（workflow 或本機）

| 變數 | 預設 | 說明 |
|------|------|------|
| `SYNC_CONCURRENCY` | `4` | 同時拉取幾張表（1–16） |
| `SYNC_PAGE_SIZE` | `1000` | PostgREST 每頁列數 |
| `SYNC_MAX_RETRIES` | `3` | 失敗重試次數 |
| `ROUTINE_TOGGLE` | `1` | `0` 關閉奇偶 routine 寫入/刪除 |
| `ROUTINE_TZ` | `Asia/Taipei` | 判斷奇/偶小時的時區 |
| `ROUTINE_TABLE` | `routine` | 目標資料表 |
| `ROUTINE_MARKER_NAME` | `[cron] odd-hour` | 標記列的 name |
| `ROUTINE_MARKER_NOTE` | `GH_CRON_ROUTINE` | 標記 note 前綴（刪除條件） |

---

## 本機執行

Node.js 20+：

```bash
# Windows PowerShell 範例
$env:SUPABASE_URL="https://xxxx.supabase.co"
$env:SUPABASE_SERVICE_ROLE_KEY="your-service-role-key"
node scripts/sync-supabase-tables.mjs
```

成功時會在 `data/` 產生／更新 JSON，並在終端印出每表 `updated` / `unchanged` 與總結。

---

## 外部排程備援

GitHub `schedule` 在負載高時可能延遲或漏跑，建議另用 cron-job.org 等服務打：

```bash
curl -X POST \
  -H "Accept: application/vnd.github+json" \
  -H "Authorization: Bearer YOUR_GITHUB_TOKEN" \
  https://api.github.com/repos/OWNER/REPO/dispatches \
  -d "{\"event_type\":\"external-sync\"}"
```

建議與內建排程錯開數分鐘（例如每小時 `:45`）。

---

## 金鑰策略建議

- **完整備份**：只配 `SUPABASE_SERVICE_ROLE_KEY`（+ URL）
- **只讀公開表**：`SUPABASE_ANON_KEY` + `SUPABASE_TABLES`

Service role 權限等同後端；外洩等於整個資料庫可讀寫，務必只放在 GitHub Secrets / 本機環境變數。
