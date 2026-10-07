# 翻頁閱讀器

版本：2026.10.07.1。`index.html`、`reader-core.js`、`reader-enhance.js` 是唯一維護來源；GitHub Pages 直接提供這三份檔案。

## 本機單檔

`npm run build:standalone -- /absolute/path/閱讀器.html` 會把兩個本機 JS 內嵌成單一 HTML。第一次覆寫會保留 `.backup-before-2026.10.07` 備份。不要再分別修改網站與輸出檔。書庫/筆記仍在原瀏覽器的 IndexedDB/localStorage，並不隨 HTML 檔案跨裝置同步。

## 驗證

- `npm test`：語言分段、聲音排序、快取去重/釋放、文字錨點、MP3 完整音框裁切、Worker 額度及失敗流程。
- `node tests/browser-smoke.cjs`：需 Playwright、Chrome、JSZip；可用 `NODE_PATH` 指向已安裝套件。測試使用自製 EPUB 與模擬系統語音，不會把使用者書籍送至雲端。
- 瀏覽器測試不能取代手機實際鎖屏測試，亦不代表所有系統語音都具相同音質。

## 語音

「自動自然選聲」從裝置提供的聲音中選擇中英文，優先增強/自然聲音。手動指定聲音只影響同語言。手機自然語音由既有 Cloudflare Worker 代理 Google；正文中英夾雜與背景音軌皆分語言合成。

暫停/續播控制實際播放器；不使用定時 pause/resume。內建語音中斷或無回應會停止並提示，不當作完成而跳句。網路失敗時，本次前景朗讀改用內建，重新播放再嘗試雲端。內建語音無法保證背景持續播放。

音訊快取最多 12 筆，相同請求共用 Promise；切換設定使舊回應失效，播放中的 URL 等釋放後才回收。

## 部署 Worker

`wrangler deploy --config worker/wrangler.jsonc`。沿用 `reader-mobile-tts` 與 `DailyQuota`，不重建或輸出現有 `GOOGLE_TTS_API_KEY` Secret。預設每日全站上限仍為 100,000 字（UTC 重置），不是每位使用者 100,000 字。

Worker 只退款「未送到 Google」的文字，超時/部分失敗保守計入用量。這不是帳單保證：端點仍公開、不同聲音單價不同，Google Cloud 預算警示仍需保留。勿在前端加入 API key。

背景音軌以 MP3 音框的實際時長限制上限，最多指定分鐘數（若剩餘書籍較短會提早結束）。暫存 3 小時，支援 Range；Cache API 只在所在地資料中心有效，切換網路遇到音訊過期須重新準備。

## 筆記相容性

EPUB/Word 新劃記保存原文位置及選取文字，重新分頁不再依賴舊頁碼。既有劃記首次重排前按目前版面轉換，舊資料保留在 `_legacy_backup`，已在更早版本錯位的舊標記不能自動推知正確原文。掃描 PDF 原頁與 OCR 重排筆記分開保存，避免相互誤套。

## 技術依據

- [Google AudioConfig](https://docs.cloud.google.com/text-to-speech/docs/reference/rest/v1/AudioConfig)：MP3、語速與取樣率設定。
- [Cloudflare Cache API](https://developers.cloudflare.com/workers/runtime-apis/cache/)：音訊快取與 Range 支援，快取不是永久儲存。
