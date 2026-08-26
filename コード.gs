/**
 * 出張距離測定・申請ガイド ─ アプリ配信＋経路検索API（Google Apps Script）
 * =====================================================================
 * Google Cloud の APIキー・課金設定は一切不要です。
 * GAS に内蔵されている Maps サービス（Maps.newDirectionFinder / newGeocoder）で
 * Google の高精度なルート・住所データを使います。
 *
 * このGASは2役を兼ねます：
 *   (1) パラメータなしでアクセス → アプリ本体(HTML)を配信（index.htmlを自動取得）
 *   (2) origin/dest や q を付けてアクセス → ルート/住所検索の結果をJSONで返す
 * これにより GitHub を使わず、すべて Google ドメイン（script.google.com）で完結し、
 * 学校など GitHub が開けない環境でも Google サイトに埋め込んで使えます。
 *
 * 【セットアップ手順】
 *   1. GitHubリポジトリを Public にする（GASがHTMLを読みに行くため）
 *   2. （前回の）GASプロジェクトを開き、このコードを貼り替えて保存
 *   3. 下の APP_HTML_URL が自分のリポジトリの raw URL になっているか確認
 *   4. デプロイ → デプロイを管理 → 鉛筆 → バージョン「新バージョン」→ デプロイ
 *      （初回は UrlFetch の権限を求められるので許可する）
 *   5. exec URL を開くと、アプリ画面が表示される（GASが index.html を取得して配信）
 *   6. （任意）Googleサイトに、その exec URL を iframe で埋め込む
 *
 * ※ 巨大HTMLを手で貼り付ける必要はありません。GASが自動取得します。
 *    index.html を更新すれば、最大10分ほどで配信内容も自動更新されます。
 *    page.html 内の GAS_API_URL は、この exec URL を指定しておくこと。
 *
 * 【リクエスト（GET クエリパラメータ）】
 *   origin        必須  "緯度,経度"            例: 34.781,135.452
 *   dest          必須  "緯度,経度"
 *   waypoints     任意  "緯度,経度|緯度,経度"  経由地（手動修正用）
 *   avoidHighways 任意  "1" で高速道路を回避
 *   avoidTolls    任意  "1" で有料道路を回避
 *   alternatives  任意  "1" で代替ルートも返す
 *   （有料道路の有無は Google の警告情報 warnings から自動判定します）
 *
 * 【レスポンス（JSON）】
 *   成功: { ok:true,  routes:[ { distance, duration, polyline, summary, hasToll } ] }
 *           distance … 総距離（メートル）
 *           duration … 所要時間（秒）
 *           polyline … エンコード済みポリライン（Google精度5）
 *           hasToll  … 有料道路を含むと推定されるか（boolean）
 *   失敗: { ok:false, error:"..." }
 */

// アプリ本体(index.html)の raw URL。リポジトリ/ブランチが違う場合はここを直す。
// ※ この方式は GitHubリポジトリが Public である必要があります。
var APP_HTML_URL = 'https://raw.githubusercontent.com/edupower07/maps/main/index.html';

/* ============================================================
 *  利用制限（アクセス制御）の設定
 * ============================================================
 * URLが無制限に広がるのを防ぐため、「利用申請をした人だけが使える」ようにします。
 * 判定は次の順で行います。
 *   ① RESTRICT_TO_DOMAINS 以外のドメイン → 拒否（申請があっても使えない）
 *   ② ADMIN_EMAILS に入っている          → 許可
 *   ③ AUTO_ALLOW_DOMAINS のドメイン      → 許可（申請不要にしたい場合のみ。通常は空）
 *   ④ 申請フォームの回答シートに載っている  → 許可（自動。手作業の追加は不要）
 * 当てはまらない人には「利用申請はこちら」の案内を表示します。
 *
 * 【使い始めるまでの手順】
 *   1. GASエディタで関数 setupApplicationForm を1回実行する
 *      → 申請フォーム（名前・学校名・役職／メールは自動収集）と回答シートが
 *        自動で作られ、必要な設定も自動で保存されます
 *   2. 実行結果に表示される「申請フォームのURL」を職員に案内する
 *   3. ACCESS_CONTROL_ENABLED が true になっていることを確認
 *   4. 「デプロイ → デプロイを管理 → 鉛筆 → 新バージョン」で再デプロイ
 * ※ 手動で作る場合は、回答シートのIDを ALLOWLIST_SHEET_ID、フォームURLを
 *    APPLY_FORM_URL に設定してください（スクリプト プロパティでも可）。
 *
 * 【重要：GASプロジェクトの所有者について】
 * 利用者のメールアドレスを取得できるのは、次のどちらかの場合だけです。
 *   ・GASの所有者と利用者が「同じドメイン」のアカウント（推奨）
 *   ・デプロイの実行ユーザーを「ウェブアプリにアクセスしているユーザー」にした場合
 * 個人のGmailアカウントでGASを作っていると、学校ドメイン(例 kita9.ed.jp)の
 * 利用者のアドレスが取得できず、全員が「未登録」になってしまいます。
 * その場合は、学校ドメインのアカウントでGASプロジェクトを作り直してください。
 * 有効にする前に、必ず「?whoami=1」を職員のアカウントで開いて確認すること。
 */
var ACCESS_CONTROL_ENABLED = true;    // false にすると誰でも使える（制限なし）

// 管理者（常に利用可）。※このファイルはGitHubで公開されるため、
// 個人のメールアドレスはここに直接書かず、GASの
// 「プロジェクトの設定 → スクリプト プロパティ」に
// キー ADMIN_EMAILS ／ 値 メールアドレス（カンマ区切り）で登録してください。
var ADMIN_EMAILS = [];

// 利用できるドメインの限定。ここに書いたドメイン以外は、申請があっても利用できません。
// （空にすると、ドメインによる制限をしません）
var RESTRICT_TO_DOMAINS = [
  'kita9.ed.jp'                       // 北九州市の学校アカウントのみ
];

// 申請なしで許可するドメイン。通常は空にして、全員に申請してもらいます。
var AUTO_ALLOW_DOMAINS = [];

// フォーム回答スプレッドシートのID。ドメイン許可だけで足りる場合は空のままでOK。
// （スクリプト プロパティに ALLOWLIST_SHEET_ID を登録しても指定できます）
var ALLOWLIST_SHEET_ID = '';
var ALLOWLIST_SHEET_NAME = '';        // シート名（空なら先頭のシート）
var ALLOWLIST_EMAIL_HEADER = 'メールアドレス';  // メールアドレスの列名（自動検出もします）
var ALLOWLIST_APPROVED_HEADER = '';   // 空＝申請したら即利用可。列名を書くと、その列が
                                      // TRUE/○/承認 の行だけ許可（管理者が承認する運用）
var APPLY_FORM_URL = '';              // 利用申請フォームのURL（案内画面に表示）
var ALLOWLIST_CACHE_SEC = 300;        // 許可リストの再読み込み間隔（秒）

// ===== 利用者の確認 =====

// いまアクセスしている人のメールアドレス（取得できないときは空文字）
function currentUserEmail_() {
  try { return String(Session.getActiveUser().getEmail() || '').trim().toLowerCase(); }
  catch (e) { return ''; }
}

// 利用してよい人かどうかを判定する
function checkAccess_() {
  if (!ACCESS_CONTROL_ENABLED) return { ok: true, email: currentUserEmail_() };

  var email = currentUserEmail_();
  if (!email) {
    return { ok: false, email: '', reason: 'no-identity',
             message: 'Googleアカウントが確認できませんでした。学校のGoogleアカウントでログインした状態で開いてください。' };
  }
  // ① 管理者は、ドメインに関係なく常に利用できる
  if (configList_(ADMIN_EMAILS, 'ADMIN_EMAILS').indexOf(email) !== -1) return { ok: true, email: email };

  // ② 使えるドメインの限定（申請があってもドメイン外は許可しない）
  var domain = email.split('@')[1] || '';
  var restrict = configList_(RESTRICT_TO_DOMAINS, 'RESTRICT_TO_DOMAINS');
  if (restrict.length && restrict.indexOf(domain) === -1) {
    return { ok: false, email: email, reason: 'wrong-domain',
             message: 'このアプリは ' + restrict.join(' / ') + ' のアカウント専用です。学校のGoogleアカウントでログインし直してください。' };
  }

  // ③ 申請不要にしているドメイン（通常は空）
  if (configList_(AUTO_ALLOW_DOMAINS, 'AUTO_ALLOW_DOMAINS').indexOf(domain) !== -1) return { ok: true, email: email };

  // ④ 利用申請フォームの回答
  if (loadAllowlist_().indexOf(email) !== -1) return { ok: true, email: email };

  // 許可リストの参照先が未設定だと、申請しても誰も通れない（設定ミス）。
  // 「未登録」と区別して、管理者が気づけるようにする。
  if (!allowlistSheetId_()) {
    return { ok: false, email: email, reason: 'no-allowlist',
             message: '利用者名簿が設定されていないため、現在ご利用いただけません。管理者にお知らせください。' };
  }

  return { ok: false, email: email, reason: 'not-listed',
           message: 'このアカウントはまだ利用登録されていません。' };
}

function lower_(s) { return String(s || '').trim().toLowerCase(); }

// 設定値を「コード内の値」＋「スクリプト プロパティの値（カンマ区切り）」から作る。
// 個人のメールアドレスなどを公開リポジトリに書かずに済むようにするための仕組み。
function configList_(inCode, propKey) {
  var list = (inCode || []).map(lower_);
  try {
    var raw = PropertiesService.getScriptProperties().getProperty(propKey);
    if (raw) raw.split(',').forEach(function (v) { v = lower_(v); if (v) list.push(v); });
  } catch (e) {}
  return list;
}

// 許可リストのスプレッドシートID（スクリプト プロパティ優先）
function allowlistSheetId_() {
  return prop_('ALLOWLIST_SHEET_ID') || ALLOWLIST_SHEET_ID;
}

// 申請フォームのURL（スクリプト プロパティ優先）
function applyFormUrl_() {
  return prop_('APPLY_FORM_URL') || APPLY_FORM_URL;
}

function prop_(key) {
  try {
    var v = PropertiesService.getScriptProperties().getProperty(key);
    return v ? String(v).trim() : '';
  } catch (e) { return ''; }
}

// 申請フォームの回答シートから、許可するメールアドレスの一覧を読み込む（一定時間キャッシュ）
function loadAllowlist_() {
  var cache = CacheService.getScriptCache();
  var hit = cache.get('allowlist-v1');
  if (hit) { try { return JSON.parse(hit); } catch (e) {} }

  var list = [];
  var sheetId = allowlistSheetId_();
  if (sheetId) {
    try {
      var ss = SpreadsheetApp.openById(sheetId);
      var sh = ALLOWLIST_SHEET_NAME ? ss.getSheetByName(ALLOWLIST_SHEET_NAME) : ss.getSheets()[0];
      if (sh) list = parseAllowlistValues_(sh.getDataRange().getValues());
    } catch (err) {
      // シートが読めないときは許可リストを空として扱う（ドメイン許可・管理者は有効のまま）
      console.warn('許可リストの読み込みに失敗: ' + err);
    }
  }
  try { cache.put('allowlist-v1', JSON.stringify(list), ALLOWLIST_CACHE_SEC); } catch (e) {}
  return list;
}

// スプレッドシートの中身から、許可するメールアドレスの一覧を取り出す
function parseAllowlistValues_(values) {
  var list = [];
  if (!values || values.length < 2) return list;

  var header = values[0].map(function (h) { return String(h).trim(); });
  // メールアドレスの列を探す（指定名 → 「メール」を含む列名 → @を含む値がある列）
  var ei = header.indexOf(ALLOWLIST_EMAIL_HEADER);
  if (ei === -1) {
    for (var i = 0; i < header.length; i++) {
      if (/メール|mail/i.test(header[i])) { ei = i; break; }
    }
  }
  if (ei === -1) {
    for (var c = 0; c < header.length; c++) {
      if (String(values[1][c] || '').indexOf('@') !== -1) { ei = c; break; }
    }
  }
  if (ei === -1) return list;

  var ai = ALLOWLIST_APPROVED_HEADER ? header.indexOf(ALLOWLIST_APPROVED_HEADER) : -1;
  for (var r = 1; r < values.length; r++) {
    var mail = lower_(values[r][ei]);
    if (!mail || mail.indexOf('@') === -1) continue;
    if (ai !== -1 && !isApproved_(values[r][ai])) continue;
    if (list.indexOf(mail) === -1) list.push(mail);
  }
  return list;
}

function isApproved_(v) {
  if (v === true) return true;
  return /^(true|1|yes|○|◯|承認|可|ok)$/i.test(String(v || '').trim());
}

/** 承認後すぐ反映したいときに、この関数を手動実行してキャッシュを消す */
function clearAllowlistCache() {
  CacheService.getScriptCache().remove('allowlist-v1');
  return '許可リストのキャッシュを消去しました（次のアクセスで最新が反映されます）';
}

/**
 * 【最初に1回だけ実行】利用申請フォームと回答シートを自動で作成する。
 * GASエディタで関数一覧から setupApplicationForm を選んで実行してください。
 * 作成されるもの：
 *   ・Googleフォーム（お名前／学校名／役職。メールアドレスは自動収集）
 *   ・回答スプレッドシート
 *   ・スクリプト プロパティへの設定保存（ALLOWLIST_SHEET_ID / APPLY_FORM_URL）
 * 実行後、表示された「申請フォームのURL」を職員に案内してください。
 */
function setupApplicationForm() {
  var existing = applyFormUrl_();
  if (existing) {
    return '既に申請フォームが設定されています：' + existing +
           '\n作り直す場合は、スクリプト プロパティの APPLY_FORM_URL と ALLOWLIST_SHEET_ID を削除してから再実行してください。';
  }

  var form = FormApp.create('出張距離測定・申請ガイド　利用申請');
  form.setDescription(
    'このツールは、申請いただいた方のアカウントでのみ利用できます。\n' +
    '学校のGoogleアカウントでログインした状態でご記入ください。\n' +
    '※ ご記入いただいたアカウントで、申請後 数分以内に利用できるようになります。'
  );
  // 回答者のメールアドレスを自動で記録する（本人のアカウントと確実に一致させるため）
  try { form.setCollectEmail(true); } catch (e) {
    try { form.setEmailCollectionType(FormApp.EmailCollectionType.VERIFIED); } catch (e2) {}
  }
  form.addTextItem().setTitle('お名前').setRequired(true);
  form.addTextItem().setTitle('学校名').setRequired(true);
  form.addTextItem().setTitle('役職').setRequired(true);
  form.setConfirmationMessage(
    '申請ありがとうございました。\n数分後にアプリのURLを開くとご利用いただけます。'
  );

  var ss = SpreadsheetApp.create('出張距離測定・申請ガイド　利用申請（回答）');
  form.setDestination(FormApp.DestinationType.SPREADSHEET, ss.getId());

  PropertiesService.getScriptProperties().setProperties({
    APPLY_FORM_URL: form.getPublishedUrl(),
    ALLOWLIST_SHEET_ID: ss.getId()
  }, false);
  clearAllowlistCache();

  var appUrl = '';
  try { appUrl = ScriptApp.getService().getUrl() || ''; } catch (e) {}

  var msg =
    '✅ 申請フォームを作成し、設定も保存しました。\n\n' +
    '───────────────────────────────\n' +
    '■ 職員に配るのは「アプリのURL」だけでOKです\n' +
    (appUrl ? appUrl : '（デプロイ後に「デプロイを管理」で表示されるURL）') + '\n' +
    '  ※ 未申請の人が開くと、申請フォームへのボタンが自動で表示されます。\n' +
    '───────────────────────────────\n\n' +
    '■ 申請者の一覧（学校名・役職も確認できます）：\n' + ss.getUrl() + '\n\n' +
    '■ 申請フォーム（内容を変えたいとき）：\n' + form.getEditUrl() + '\n' +
    '   回答用URL：' + form.getPublishedUrl() + '\n\n' +
    '■ このあとの手順：\n' +
    '   「デプロイ → デプロイを管理 → 鉛筆 → 新バージョン」で再デプロイしてください。\n\n' +
    '───────── 職員へのお知らせ文（コピーして使えます） ─────────\n' +
    '【出張の距離計算ツールのご案内】\n' +
    '自家用車出張の距離計算と、申請用の地図作成ができるツールです。\n' +
    '下のURLを開き、画面の案内にしたがって利用申請をしてください。\n' +
    '申請後、数分でご利用いただけます（学校のGoogleアカウントでログインした状態で開いてください）。\n' +
    (appUrl ? appUrl : '（アプリのURL）') + '\n' +
    '────────────────────────────────────────';
  console.log(msg);
  return msg;
}

/** 【管理者向け】いま利用できる人の一覧を確認する */
function listRegisteredUsers() {
  var list = loadAllowlist_();
  var msg = '利用登録されているアカウント：' + list.length + '件\n' + list.join('\n');
  console.log(msg);
  return msg;
}

// ===== 画面表示後の通信を認証するための署名付きトークン =====
// 最初のページ表示のときだけ本人確認ができるため、そこで短時間有効の
// トークンを発行し、以降のデータ取得（アプリ本体・ルート検索）で検証する。

function appSecret_() {
  var props = PropertiesService.getScriptProperties();
  var s = props.getProperty('APP_SECRET');
  if (!s) { s = Utilities.getUuid() + Utilities.getUuid(); props.setProperty('APP_SECRET', s); }
  return s;
}

function makeToken_(email) {
  var payload = (email || 'anonymous') + '|' + (Date.now() + 12 * 60 * 60 * 1000); // 12時間有効
  var sig = Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(payload, appSecret_()));
  return Utilities.base64EncodeWebSafe(payload) + '.' + sig;
}

function verifyToken_(t) {
  try {
    var parts = String(t || '').split('.');
    if (parts.length !== 2) return null;
    var payload = Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[0])).getDataAsString();
    var sig = Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(payload, appSecret_()));
    if (sig !== parts[1]) return null;
    var seg = payload.split('|');
    if (Number(seg[1]) < Date.now()) return null;
    return seg[0];
  } catch (e) { return null; }
}

// 通信（アプリ取得・ルート検索）が許可されているか
function gateRequest_(p) {
  if (!ACCESS_CONTROL_ENABLED) return { ok: true };
  if (verifyToken_(p.t)) return { ok: true };
  return { ok: false, message: '利用の確認ができませんでした。アプリのURLを開き直してください。' };
}

// 未登録の人に見せる案内画面
function denyPage_(gate) {
  var formUrl = applyFormUrl_();
  var canApply = gate.reason === 'not-listed' && formUrl;

  var body, extra = '';
  if (gate.reason === 'wrong-domain') {
    body = 'ご利用には学校のGoogleアカウントが必要です。';
    extra = '<p style="font-size:13px;color:#666;">ブラウザで別のアカウントにログインしている場合は、学校のアカウントに切り替えてから開き直してください。</p>';
  } else if (gate.reason === 'no-allowlist') {
    body = '設定が完了していないため、現在ご利用いただけません。';
    extra = '<p style="font-size:13px;color:#666;">お手数ですが、管理者にご連絡ください。</p>' +
      '<p style="font-size:11.5px;color:#999;margin-top:14px;border-top:1px solid #eee;padding-top:10px;">' +
      '【管理者の方へ】利用者名簿（申請フォームの回答シート）が設定されていません。' +
      'この状態では申請済みの方も含め、全員が利用できません。GASエディタで ' +
      '<b>setAllowlistSheet("スプレッドシートのURL")</b> を実行して設定してください。</p>';
  } else if (gate.reason === 'no-identity') {
    body = 'Googleアカウントが確認できませんでした。';
    extra = '<p style="font-size:13px;color:#666;">学校のGoogleアカウントでログインした状態で開き直してください。</p>' +
      '<p style="font-size:11.5px;color:#999;margin-top:14px;border-top:1px solid #eee;padding-top:10px;">' +
      '【管理者の方へ】この画面が全員に出る場合は、アプリの設定の問題です。' +
      'デプロイの「アクセスできるユーザー」が<b>「全員（匿名ユーザーを含む）」</b>になっていると、' +
      'アカウントを識別できません。<b>「Googleアカウントを持つ全員」</b>（または組織内の全員）に変更して再デプロイしてください。</p>';
  } else {
    body = 'このアプリは<b>利用申請をされた方のみ</b>ご利用いただけます。';
    extra = '<p style="font-size:13px;color:#666;">申請後、数分（最大5分ほど）してから開き直すと利用できるようになります。</p>';
  }

  var applyBtn = canApply
    ? '<p style="margin-top:22px;"><a href="' + formUrl + '" target="_blank" ' +
      'style="display:inline-block;background:#1a73e8;color:#fff;text-decoration:none;padding:13px 26px;border-radius:8px;font-weight:700;">' +
      '利用を申請する（フォームへ）</a></p>' +
      '<p style="font-size:12px;color:#888;margin-top:6px;">お名前・学校名・役職をご記入ください。申請いただいたアカウントでのみ利用できます。</p>'
    : '';
  var who = gate.email
    ? '<p style="color:#666;font-size:13px;margin-top:18px;">ログイン中のアカウント：<b>' + gate.email + '</b></p>'
    : '';

  // 未申請の人にとってはここが入口になるので、どんなツールかを簡単に紹介する
  var intro = gate.reason === 'not-listed'
    ? '<div style="background:#f5f9ff;border:1px solid #dbe4f3;border-radius:10px;padding:14px 16px;margin:16px 0;font-size:13.5px;line-height:1.8;color:#333;">' +
      '自家用車で出張するときの<b>走行距離を自動で計算</b>し、通勤経路と重なる区間を差し引いて、' +
      '出張申請の「用件」欄に貼り付ける文章と、提出用の地図を作成できます。' +
      '</div>'
    : '';

  var html =
    '<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1.0"><title>利用申請のお願い</title></head>' +
    '<body style="margin:0;font-family:\'Segoe UI\',\'Yu Gothic UI\',Meiryo,sans-serif;background:#f0f2f5;">' +
    '<div style="max-width:560px;margin:8vh auto;background:#fff;border-radius:14px;padding:34px 30px;box-shadow:0 4px 18px rgba(0,0,0,.1);">' +
    '<h1 style="font-size:21px;color:#0d47a1;margin:0 0 14px;">出張距離測定・申請ガイド</h1>' +
    '<p style="font-size:15px;line-height:1.8;margin:0 0 6px;">' + body + '</p>' +
    '<p style="font-size:14px;line-height:1.8;color:#444;margin:0;">' + (gate.message || '') + '</p>' +
    intro + applyBtn + extra + who +
    '</div></body></html>';

  return HtmlService.createHtmlOutput(html)
    .setTitle('利用申請のお願い')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function doGet(e) {
  var p = (e && e.parameter) || {};

  // ── 動作確認用：?whoami=1 で「自分のアカウントが認識されているか」を確認できる ──
  // 利用制限を有効にする前に、これで職員のアカウントが取得できるか必ず確かめること。
  // （表示されるのはアクセスした本人の情報だけなので安全です）
  if (p.whoami === '1') {
    var w = checkAccess_();
    return json_({
      ok: true,
      email: currentUserEmail_() || '(取得できませんでした)',
      allowed: w.ok,
      reason: w.reason || null,
      controlEnabled: ACCESS_CONTROL_ENABLED,
      hint: currentUserEmail_()
        ? 'アカウントを認識できています。allowed が true なら利用できます。'
        : 'アカウントを認識できていません。GASプロジェクトの所有者と利用者のドメインが違う可能性があります（下の「所有者について」を確認してください）。'
    });
  }

  // ── APIリクエスト（ルート検索 / 住所・施設検索）はJSONを返す ──
  if (p.origin || p.dest || p.q || p.mode) {
    var apiGate = gateRequest_(p);
    if (!apiGate.ok) return json_({ ok: false, error: apiGate.message, denied: true });
    return json_(apiResult_(p));
  }

  // ── アプリ本体のHTMLを「テキスト」として返す（起動ページから読み込む用） ──
  // Apps Script に大きなHTMLを解釈させると document.write でエラーになるため、
  // HTMLは解釈させずテキストとして渡し、ブラウザ側で描画する。
  if (p.html === '1') {
    var htmlGate = gateRequest_(p);
    if (!htmlGate.ok) {
      return ContentService.createTextOutput(
        '<div style="font-family:sans-serif;padding:26px;line-height:1.8">' +
        '<h2>利用の確認ができませんでした</h2><p>' + htmlGate.message + '</p></div>')
        .setMimeType(ContentService.MimeType.TEXT);
    }
    try {
      // アプリ側から通信するときに使うトークンと、このGAS自身のURLを埋め込んで返す。
      // URLを渡すことで、学校ごとに別のGASを立てても各自のGASに通信が向く。
      var token = ACCESS_CONTROL_ENABLED ? String(p.t || '') : '';
      var inject = '<script>window.__APP_TOKEN=' + JSON.stringify(token) +
                   ';window.__GAS_URL=' + JSON.stringify(ScriptApp.getService().getUrl()) + ';<\/script>\n';
      return ContentService.createTextOutput(inject + fetchAppHtml_())
        .setMimeType(ContentService.MimeType.TEXT);
    } catch (err) {
      return ContentService.createTextOutput('<h2>取得失敗</h2><p>' + String((err && err.message) || err) + '</p>')
        .setMimeType(ContentService.MimeType.TEXT);
    }
  }

  // ── それ以外（パラメータなし）は、小さな「起動ページ」を配信する ──
  // この最初のアクセスだけは利用者のGoogleアカウントを確認できるので、
  // ここで利用可否を判定し、許可された人にだけトークン付きの起動ページを返す。
  var gate = checkAccess_();
  if (!gate.ok) return denyPage_(gate);
  return bootstrapPage_(ACCESS_CONTROL_ENABLED ? makeToken_(gate.email) : '');
}

/**
 * 【画面側から呼ばれる】アプリ本体のHTMLを返す。
 * google.script.run 経由で呼ばれるため、ログイン情報が確実に伝わる。
 */
function getAppHtml() {
  var gate = checkAccess_();
  if (!gate.ok) throw new Error(gate.message || '利用が許可されていません。');
  return fetchAppHtml_();
}

/**
 * 【画面側から呼ばれる】ルート検索・住所検索。
 * params は { origin, dest, waypoints, avoidHighways, ... } または { mode:'geocode', q }
 */
function apiCall(params) {
  var gate = checkAccess_();
  if (!gate.ok) return { ok: false, error: gate.message, denied: true };
  return apiResult_(params || {});
}

// 小さな起動ページ。アプリ本体(HTML)を google.script.run で受け取り、
// この画面の中に組み立てる。Apps Script の HTML 配信はこの小さなページだけなので壊れない。
function bootstrapPage_(token) {
  var self = '';
  try { self = ScriptApp.getService().getUrl() || ''; } catch (e) {}

  var boot =
    '<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">' +
    '<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">' +
    '<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"><\/script>' +
    '<style>html,body{margin:0;height:100%;font-family:"Segoe UI","Yu Gothic UI",Meiryo,sans-serif}' +
    '#boot-msg{padding:24px;color:#555;font-size:15px}</style>' +
    '</head><body><div id="boot-msg">読み込み中…</div>' +
    '<script>' +
    'window.__APP_TOKEN=' + JSON.stringify(token || '') + ';' +
    'window.__GAS_URL=' + JSON.stringify(self) + ';' +
    'window.__GAS_MODE=true;' +
    'function bootFail(e){var m=document.getElementById("boot-msg");' +
    'if(m)m.innerHTML="<b>読み込みに失敗しました</b><br>"+((e&&e.message)||e)+' +
    '"<br><br>ページを再読み込みしてもうまくいかない場合は、学校のGoogleアカウントでログインしているかご確認ください。";}' +
    'function bootRender(html){try{' +
    // <style> を head へ移す
    'var st=html.match(/<style[\\s\\S]*?<\\/style>/gi)||[];' +
    'for(var i=0;i<st.length;i++){var w=document.createElement("div");w.innerHTML=st[i];' +
    'if(w.firstChild)document.head.appendChild(w.firstChild);}' +
    // <body> の中身を取り出し、スクリプトだけ分離
    'var bm=html.match(/<body[^>]*>([\\s\\S]*)<\\/body>/i);var bh=bm?bm[1]:html;var sc=[];' +
    'bh=bh.replace(/<script[\\s\\S]*?<\\/script>/gi,function(m){sc.push(m);return "";});' +
    'document.body.innerHTML=bh;' +
    // 分離したスクリプトを実行（この方法なら google.script.run が生き続ける）
    'for(var j=0;j<sc.length;j++){var code=sc[j].replace(/^<script[^>]*>/i,"").replace(/<\\/script>$/i,"");' +
    'var el=document.createElement("script");el.text=code;document.body.appendChild(el);}' +
    '}catch(err){bootFail(err);}}' +
    'google.script.run.withSuccessHandler(bootRender).withFailureHandler(bootFail).getAppHtml();' +
    '<\/script></body></html>';

  return HtmlService.createHtmlOutput(boot)
    .setTitle('出張距離測定・申請ガイド')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1.0');
}

// キャッシュは1件あたり100KBまでのため、大きいHTMLは分割して保存する。
// （分割しないとキャッシュできず、開くたびに毎回GitHubへ取りに行くことになる）
var CACHE_CHUNK_CHARS = 30000;   // 日本語が多くても100KBに収まる余裕をもたせた文字数

function cacheGetLarge_(cache, key) {
  var n = Number(cache.get(key + ':n') || 0);
  if (!n) return null;
  var keys = [];
  for (var i = 0; i < n; i++) keys.push(key + ':' + i);
  var map = cache.getAll(keys);
  var out = '';
  for (var j = 0; j < n; j++) {
    var part = map[key + ':' + j];
    if (part == null) return null;   // 一部でも期限切れなら使わない
    out += part;
  }
  return out;
}

function cachePutLarge_(cache, key, value, sec) {
  var n = Math.ceil(value.length / CACHE_CHUNK_CHARS);
  if (n > 30) return;                // 想定外に大きい場合はキャッシュしない
  var obj = {};
  for (var i = 0; i < n; i++) obj[key + ':' + i] = value.substr(i * CACHE_CHUNK_CHARS, CACHE_CHUNK_CHARS);
  obj[key + ':n'] = String(n);
  cache.putAll(obj, sec);
}

// index.html をネット経由で取得（Googleのサーバーが代行）。10分間キャッシュ。
function fetchAppHtml_() {
  var cache = CacheService.getScriptCache();
  var key = 'app-html-v2';
  var cached = cacheGetLarge_(cache, key);
  if (cached) return cached;

  var res = UrlFetchApp.fetch(APP_HTML_URL, { muteHttpExceptions: true, followRedirects: true });
  var code = res.getResponseCode();
  if (code !== 200) {
    throw new Error('アプリHTMLの取得に失敗しました（HTTP ' + code + '）。リポジトリがPublicか、URLが正しいか確認してください。');
  }
  var html = res.getContentText('UTF-8');
  // 分割して保存するので、100KBを超えるHTMLでもキャッシュが効く
  try { cachePutLarge_(cache, key, html, 600); } catch (e) {}
  return html;
}

/** アプリを更新した直後に、すぐ反映させたいときに手動実行する */
function clearAppHtmlCache() {
  var cache = CacheService.getScriptCache();
  var n = Number(cache.get('app-html-v2:n') || 0);
  var keys = ['app-html-v2:n'];
  for (var i = 0; i < n; i++) keys.push('app-html-v2:' + i);
  cache.removeAll(keys);
  return 'アプリHTMLのキャッシュを消去しました（次のアクセスで最新が読み込まれます）';
}

/**
 * ルート検索・住所検索の中身。doGet（fetch経由）と apiCall（google.script.run経由）で共用する。
 */
function apiResult_(p) {
  try {
    // 住所・施設の検索（ジオコーディング）
    if (p.mode === 'geocode' || p.q) return geocode_(p.q);

    var origin = parseLatLng_(p.origin);
    var dest   = parseLatLng_(p.dest);
    if (!origin || !dest) {
      throw new Error('origin / dest が不正です（"緯度,経度" 形式で指定してください）');
    }

    var routes = findRoutes_(origin, dest, {
      avoidHighways: p.avoidHighways === '1',
      avoidTolls:    p.avoidTolls === '1',
      alternatives:  p.alternatives === '1',
      waypoints:     parseWaypoints_(p.waypoints)
    });

    return { ok: true, routes: routes };
  } catch (err) {
    var msg = String((err && err.message) || err);
    // 1日の利用上限に達した場合（課金は一切発生せず、翌日には自動で戻る）。
    // 距離が「推定値」にすり替わったまま申請されるのを防ぐため、明示して返す。
    if (/too many times|Service invoked|上限|quota/i.test(msg)) {
      return { ok: false, quotaExceeded: true,
               error: '本日のGoogleマップ利用上限に達しました。日付が変わると自動的に戻ります。' +
                      '（この状態では正確な距離が出せません。申請には使わないでください）' };
    }
    return { ok: false, error: msg };
  }
}

// ===== 使用量の記録（1日あたり何回Googleマップを呼んだか） =====
// GASのMapsサービスには1日あたりの利用上限があるため、実際の消費量を
// 記録しておき、showUsage() で確認できるようにする。

function countMapsCall_(kind) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(500);
  } catch (e) { /* 混み合っているときは数えそこねてもよい（目安のため） */ }
  try {
    var props = PropertiesService.getScriptProperties();
    var key = 'usage-' + Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
    var cur = JSON.parse(props.getProperty(key) || '{}');
    cur[kind] = (cur[kind] || 0) + 1;
    cur.total = (cur.total || 0) + 1;
    props.setProperty(key, JSON.stringify(cur));
  } catch (e) {
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}

/** 【管理者向け】直近の利用状況（1日あたりのGoogleマップ呼び出し回数）を確認する */
function showUsage() {
  var props = PropertiesService.getScriptProperties();
  var all = props.getProperties();
  var rows = [];
  Object.keys(all).forEach(function (k) {
    if (k.indexOf('usage-') !== 0) return;
    var d = k.substring(6);
    var v = {};
    try { v = JSON.parse(all[k]); } catch (e) {}
    rows.push({ date: d, total: v.total || 0, route: v.route || 0, geocode: v.geocode || 0 });
  });
  rows.sort(function (a, b) { return a.date < b.date ? 1 : -1; });

  // 30日より古い記録は消しておく
  rows.slice(30).forEach(function (r) { props.deleteProperty('usage-' + r.date); });

  var lines = ['日付        合計   ルート検索  住所検索'];
  rows.slice(0, 14).forEach(function (r) {
    lines.push(r.date + '  ' + String(r.total).padStart(5) + String(r.route).padStart(11) + String(r.geocode).padStart(10));
  });
  var msg = rows.length
    ? '■ 1日あたりのGoogleマップ呼び出し回数（直近14日）\n' + lines.join('\n') +
      '\n\n※ 目安：1件の出張申請で 5〜6回（用務地1か所の場合）消費します。'
    : 'まだ利用記録がありません。';
  console.log(msg);
  return msg;
}

// ===== アカウント別の利用ログ =====
// 「誰が・いつ・何をしたか（回数）」を申請者名簿と同じスプレッドシートに記録する。
// ※ 用務地や住所などの行き先情報は記録しない（利用状況の把握に不要なため）。

var USAGE_LOG_SHEET_NAME = '利用ログ';

function usageLogSheet_() {
  var id = allowlistSheetId_();
  if (!id) return null;
  var ss = SpreadsheetApp.openById(id);
  var sh = ss.getSheetByName(USAGE_LOG_SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(USAGE_LOG_SHEET_NAME);
    sh.appendRow(['日時', 'メールアドレス', '操作', '用務地の数']);
    sh.setFrozenRows(1);
  }
  return sh;
}

/**
 * 【画面側から呼ばれる】利用を1件記録する。
 * kind … '距離計算' / '通勤ルート確定' など。stops … 用務地の数（任意）
 */
function logUsage(kind, stops) {
  var gate = checkAccess_();
  if (!gate.ok) return 'NG: 利用が許可されていません（' + (gate.reason || '') + '）';
  if (!allowlistSheetId_()) {
    return 'NG: 記録先が未設定です（スクリプト プロパティ ALLOWLIST_SHEET_ID がありません）';
  }
  var lock = LockService.getScriptLock();
  try { lock.waitLock(3000); } catch (e) { return 'NG: ほかの処理と競合しました'; }
  try {
    var sh = usageLogSheet_();
    sh.appendRow([new Date(), gate.email, String(kind || '不明'), stops == null ? '' : Number(stops)]);
    return 'OK';
  } catch (e) {
    var msg = 'NG: ' + String((e && e.message) || e);
    console.warn('利用ログの記録に失敗: ' + msg);
    return msg;
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}

/**
 * 【設定用】利用者名簿（申請フォームの回答シート）を指定する。
 * 例： setAllowlistSheet("https://docs.google.com/spreadsheets/d/xxxx/edit")
 * ※ すでにフォームを手作りしている場合は、この関数で紐づけてください。
 */
function setAllowlistSheet(urlOrId) {
  var s = String(urlOrId || '').trim();
  var m = s.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  var id = m ? m[1] : s;
  if (!id) return 'NG: スプレッドシートのURLまたはIDを渡してください。';
  var name;
  try { name = SpreadsheetApp.openById(id).getName(); }
  catch (e) { return 'NG: そのスプレッドシートを開けません（URL/IDをご確認ください）: ' + e; }
  PropertiesService.getScriptProperties().setProperty('ALLOWLIST_SHEET_ID', id);
  clearAllowlistCache();
  var msg = '✅ 利用者名簿を設定しました：' + name + '\n' +
            '   ID：' + id + '\n' +
            '   これで申請済みの方が利用できるようになります（反映は即時）。';
  console.log(msg);
  return msg;
}

/**
 * 【設定用】管理者のメールアドレスを登録する（常に利用可・複数はカンマ区切り）。
 * 例： setAdminEmails("t1650644@kita9.ed.jp")
 */
function setAdminEmails(emails) {
  var v = String(emails || '').trim();
  if (!v) return 'NG: メールアドレスを渡してください。';
  PropertiesService.getScriptProperties().setProperty('ADMIN_EMAILS', v);
  var msg = '✅ 管理者を登録しました：' + v;
  console.log(msg);
  return msg;
}

/**
 * 【動作確認用】利用ログが正しく記録できるかを調べる。
 * GASエディタで関数一覧から testUsageLog を選んで実行してください。
 * どこでつまずいているかが結果に表示されます。
 */
function testUsageLog() {
  var lines = [];
  var email = currentUserEmail_();
  lines.push('1. ログイン中のアカウント：' + (email || '(取得できませんでした)'));

  var gate = checkAccess_();
  lines.push('2. 利用の可否：' + (gate.ok ? 'OK' : 'NG（' + (gate.reason || '') + '）'));

  var id = allowlistSheetId_();
  lines.push('3. 記録先スプレッドシートID：' + (id || '(未設定)'));
  if (!id) {
    lines.push('');
    lines.push('→ 記録先が未設定です。setupApplicationForm を実行するか、');
    lines.push('   スクリプト プロパティに ALLOWLIST_SHEET_ID を登録してください。');
    var msg0 = lines.join('\n'); console.log(msg0); return msg0;
  }

  try {
    var ss = SpreadsheetApp.openById(id);
    lines.push('4. スプレッドシート：' + ss.getName());
    lines.push('   URL：' + ss.getUrl());
  } catch (e) {
    lines.push('4. スプレッドシートを開けません：' + e);
    var msg1 = lines.join('\n'); console.log(msg1); return msg1;
  }

  var r = logUsage('動作確認', 0);
  lines.push('5. テスト記録：' + r);
  lines.push('');
  lines.push(r === 'OK'
    ? '→ 正常です。スプレッドシートの「利用ログ」タブを確認してください（この確認行は削除して構いません）。'
    : '→ 上の理由で記録できていません。');
  var msg = lines.join('\n');
  console.log(msg);
  return msg;
}

/**
 * 【管理者向け】アカウント別の利用状況を集計する。
 * days … 集計する日数（既定30日）
 */
function showUserUsage(days) {
  days = days || 30;
  var sh = usageLogSheet_();
  if (!sh) return '利用ログがありません（先に setupApplicationForm を実行してください）。';
  var values = sh.getDataRange().getValues();
  if (values.length < 2) return 'まだ利用記録がありません。';

  var since = new Date().getTime() - days * 24 * 60 * 60 * 1000;
  var byUser = {}, byKind = {}, total = 0;
  for (var r = 1; r < values.length; r++) {
    var t = values[r][0];
    var time = (t instanceof Date) ? t.getTime() : new Date(t).getTime();
    if (!time || time < since) continue;
    var mail = String(values[r][1] || '(不明)');
    var kind = String(values[r][2] || '不明');
    byUser[mail] = (byUser[mail] || 0) + 1;
    byKind[kind] = (byKind[kind] || 0) + 1;
    total++;
  }

  var users = Object.keys(byUser).sort(function (a, b) { return byUser[b] - byUser[a]; });
  var lines = [];
  lines.push('■ 直近' + days + '日の利用状況');
  lines.push('利用した人数：' + users.length + '人 ／ 合計 ' + total + ' 回');
  lines.push('');
  Object.keys(byKind).forEach(function (k) { lines.push('  ' + k + '：' + byKind[k] + ' 回'); });
  lines.push('');
  lines.push('■ アカウント別（多い順）');
  users.forEach(function (m, i) {
    lines.push(String(i + 1).padStart(3) + '. ' + m + '  ' + byUser[m] + ' 回');
  });
  var msg = lines.join('\n');
  console.log(msg);
  return msg;
}

/**
 * DirectionFinder で経路を検索し、共通形式の配列にして返す。
 */
function findRoutes_(origin, dest, opt) {
  var finder = Maps.newDirectionFinder()
    .setOrigin(origin.lat, origin.lng)
    .setDestination(dest.lat, dest.lng)
    .setMode(Maps.DirectionFinder.Mode.DRIVING)
    // 道路名を日本語で返す（例: Route 1 → 国道1号）
    .setLanguage('ja')
    // 出発時刻を「今」にして交通状況を考慮させる。
    // Googleマップのアプリ・サイトは常に交通状況込みでルートを提案するため、
    // これを渡さないと提案ルートがGoogleマップの表示とズレる原因になる。
    .setDepart(new Date(Date.now() + 60 * 1000));

  if (opt.alternatives)  finder.setAlternatives(true);
  if (opt.avoidHighways) finder.setAvoid(Maps.DirectionFinder.Avoid.HIGHWAYS);
  if (opt.avoidTolls)    finder.setAvoid(Maps.DirectionFinder.Avoid.TOLLS);
  (opt.waypoints || []).forEach(function (w) { finder.addWaypoint(w.lat, w.lng); });

  countMapsCall_('route');
  var res = finder.getDirections();
  if (!res || res.status !== 'OK' || !res.routes || !res.routes.length) {
    throw new Error('ルートが見つかりません（status=' + (res && res.status) + '）');
  }

  return res.routes.map(function (route) {
    var distance = 0, duration = 0;
    (route.legs || []).forEach(function (leg) {
      distance += (leg.distance && leg.distance.value) || 0; // メートル
      duration += (leg.duration && leg.duration.value) || 0; // 秒
    });
    return {
      distance: distance,
      duration: duration,
      polyline: routePolyline_(route),
      summary: route.summary || '',
      // 有料道路の有無は Google 公式の警告情報（warnings）から判定する。
      // 例：「この経路には有料道路が含まれています。」/ "This route has tolls."
      hasToll: (route.warnings || []).some(function (w) { return /有料|toll/i.test(String(w)); })
    };
  });
}

/**
 * ルートの形状ポリラインを返す。
 * overview_polyline は簡略化されていて頂点が粗く（直線部で数百m間隔）、
 * 地図表示のズレや重複区間の取りこぼしの原因になるため、
 * 各ステップの詳細ポリラインを連結した高解像度の線を優先して返す。
 */
function routePolyline_(route) {
  try {
    var pts = [];
    (route.legs || []).forEach(function (leg) {
      (leg.steps || []).forEach(function (st) {
        var enc = st.polyline && st.polyline.points;
        if (!enc) return;
        var dec = Maps.decodePolyline(enc); // [lat, lng, lat, lng, ...]
        var start = 0;
        // 接続点の重複を除いて連結
        if (pts.length >= 2 && dec.length >= 2 &&
            pts[pts.length - 2] === dec[0] && pts[pts.length - 1] === dec[1]) start = 2;
        for (var k = start; k < dec.length; k++) pts.push(dec[k]);
      });
    });
    if (pts.length >= 4) return Maps.encodePolyline(pts);
  } catch (e) { /* 失敗時は overview にフォールバック */ }
  return (route.overview_polyline && route.overview_polyline.points) || '';
}

/**
 * 住所・施設名を Google ジオコーダ（GAS内蔵・APIキー不要）で検索する。
 * 返り値: { ok:true, results:[ { name, addr, lat, lng, location_type, types, approx } ] }
 *   approx … 市区町村や都道府県の中心など「ざっくりした位置」かどうか
 * 注意: GASのMapsサービスはジオコーダ（住所中心）のみで、Places（施設名検索）は
 *       使えません。施設名は当たることもありますが、住所のほうが確実です。
 */
function geocode_(q) {
  q = (q || '').trim();
  if (!q) return { ok: false, error: 'q（検索語）を指定してください' };

  var geocoder = Maps.newGeocoder().setLanguage('ja').setRegion('jp');
  countMapsCall_('geocode');
  var res = geocoder.geocode(q);
  if (!res || (res.status !== 'OK' && res.status !== 'ZERO_RESULTS')) {
    return { ok: false, error: 'ジオコーディング失敗（status=' + (res && res.status) + '）' };
  }

  var results = (res.results || []).map(function (r) {
    var loc = r.geometry && r.geometry.location;
    var types = r.types || [];
    // 都道府県・市区町村レベルの「中心」しか出ていない＝施設・番地までは特定できていない
    var approx = (r.geometry && r.geometry.location_type === 'APPROXIMATE') &&
      types.some(function (t) {
        return t === 'locality' || t === 'political' || t === 'sublocality' ||
               t === 'administrative_area_level_1' || t === 'administrative_area_level_2';
      });
    return {
      name: r.formatted_address || '',
      addr: r.formatted_address || '',
      lat: loc ? loc.lat : null,
      lng: loc ? loc.lng : null,
      location_type: (r.geometry && r.geometry.location_type) || '',
      types: types,
      partial: !!r.partial_match,
      approx: approx
    };
  }).filter(function (r) { return r.lat != null && r.lng != null; });

  return { ok: true, results: results };
}

/** "緯度,経度" → {lat, lng}（不正なら null） */
function parseLatLng_(s) {
  if (!s) return null;
  var parts = String(s).split(',');
  if (parts.length < 2) return null;
  var lat = parseFloat(parts[0]), lng = parseFloat(parts[1]);
  if (isNaN(lat) || isNaN(lng)) return null;
  return { lat: lat, lng: lng };
}

/** "緯度,経度|緯度,経度" → [{lat,lng}, ...] */
function parseWaypoints_(s) {
  if (!s) return [];
  return String(s).split('|').map(parseLatLng_).filter(function (v) { return v; });
}

/** オブジェクトを JSON レスポンスにする */
function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
