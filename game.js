// ============================================
// スライム牧場（slime-farm）
// ============================================
// 買う（タマゴ）・捕まえる（のはら）・産ませる（すみか）でスライムを増やし、
// 同じ種類を重ねて進化 → ごうせい台でレシピ合成 → つよいスライムでボスをとうばつ。
// 設計は docs/PLAN_slime-farm.md。
//
// - 上半分は純ロジック（種類テーブル・式）。Node から require してバランスを確かめられる
// - 経済は setInterval(100ms) の実時間で回す。rAF は背景タブで止まるので描画にだけ使う
// - 捕獲リングの成否は「タップ時刻 − リング開始時刻」で決める（描画フレームに依存させない）
// - スプライトは Gemini 生成（docs/slime-farm-sprite-prompts.md）。読めなければ canvas の仮スライムで動く
// ============================================

(function () {
  'use strict';

  // 言語別テキスト（英語版ページが window.GAME_TEXT を定義して上書きする。docs/i18n.md 参照）。
  // 上半分は Node からも読み込むので window の有無をガードする
  var TEXT = (typeof window !== 'undefined' && window.GAME_TEXT) || {};

  // 「英語では何も付けない」訳がありうる単位は、空文字も有効な訳として扱う
  // （TEXT.x || '匹' と書くと空文字が falsy で日本語に戻ってしまう）
  function tx(key, fallback) {
    return TEXT[key] !== undefined ? TEXT[key] : fallback;
  }
  // {n} のような差しこみ口を持つ文。fmt('あと{n}匹', { n: 3 })
  function fmt(tpl, vars) {
    return String(tpl).replace(/\{(\w+)\}/g, function (m, k) {
      return vars && vars[k] !== undefined ? vars[k] : m;
    });
  }
  function tf(key, fallback, vars) { return fmt(tx(key, fallback), vars); }

  // ============================================
  // 種類テーブル（54種）
  // ============================================
  // key は保存データに入るので公開後は変えないこと。
  // evolve: 同じ種類2匹で進化する先。配列は施設で枝分かれ（need = 施設id）
  // recipe: ごうせい台で違う種類2匹から生まれる（順不同）
  // line: とうばつの相性に使う系統（合成種は計画書の表の先頭の系統）
  var SPECIES = {
    green:    { line: 'grass', stage: 1, income: 1,     power: 10,   evolve: 'leaf', name: 'みどりスライム', note: '牧場のはじまりのスライム。いつもぷるぷる' },
    leaf:     { line: 'grass', stage: 2, income: 3,     power: 25,   evolve: 'bud', name: 'はっぱスライム', note: 'あたまのはっぱで、おひさまをあびている' },
    bud:      { line: 'grass', stage: 3, income: 9,     power: 60,   evolve: [{ to: 'flower', need: 'flowerbed' }, { to: 'mushroom', need: 'log' }], name: 'つぼみスライム', note: 'もうすぐさきそう。はなのみつ か きのこ をあげると進化先がきまる' },
    flower:   { line: 'grass', stage: 4, income: 27,    power: 150,  name: 'はなスライム', note: 'いいにおいで、みんなをげんきにする' },
    mushroom: { line: 'grass', stage: 4, income: 27,    power: 150,  name: 'きのこスライム', note: 'しめったまるたがだいすき' },
    blue:     { line: 'water', stage: 1, income: 2,     power: 15,   evolve: 'bubble', name: 'あおスライム', note: 'みずべでうまれた、ひんやりスライム' },
    bubble:   { line: 'water', stage: 2, income: 6,     power: 40,   evolve: 'wave', name: 'あわスライム', note: 'しゃぼんだまをぷかぷかとばす' },
    wave:     { line: 'water', stage: 3, income: 18,    power: 100,  evolve: [{ to: 'sea', need: 'well' }, { to: 'ice', need: 'icehouse' }], name: 'なみスライム', note: 'からだのなみがざぶーんとゆれる。わきみず か こおりのみ をあげると進化先がきまる' },
    sea:      { line: 'water', stage: 4, income: 54,    power: 250,  name: 'うみスライム', note: 'かいがらをたからものにしている' },
    ice:      { line: 'water', stage: 4, income: 54,    power: 250,  name: 'こおりスライム', note: 'さわるとつめたい。なつに大人気' },
    red:      { line: 'fire',  stage: 1, income: 4,     power: 20,   evolve: 'flame', name: 'あかスライム', note: 'かざんでうまれた、あったかスライム' },
    flame:    { line: 'fire',  stage: 2, income: 12,    power: 60,   evolve: 'magma', name: 'ほのおスライム', note: 'あたまのほのおは、さわってもあつくない' },
    magma:    { line: 'fire',  stage: 3, income: 36,    power: 160,  evolve: [{ to: 'sun', need: 'mirror' }, { to: 'thunder', need: 'rod' }], name: 'マグマスライム', note: 'ぐつぐつにえている。ひかりのつぶ か でんきのみ をあげると進化先がきまる' },
    sun:      { line: 'fire',  stage: 4, income: 108,   power: 400,  name: 'たいようスライム', note: 'まぶしくて、まわりがあかるくなる' },
    thunder:  { line: 'fire',  stage: 4, income: 108,   power: 400,  name: 'かみなりスライム', note: 'ビリビリ。ちかづくとかみの毛がたつ' },
    ajisai:   { line: 'grass', stage: 3, income: 30,    power: 90,   recipe: ['leaf', 'bubble'], name: 'あじさいスライム', note: 'あめの日がいちばんげんき' },
    yakiimo:  { line: 'grass', stage: 3, income: 50,    power: 120,  recipe: ['leaf', 'flame'], name: 'やきいもスライム', note: 'ほくほく。いいにおいがする' },
    onsen:    { line: 'water', stage: 3, income: 60,    power: 130,  recipe: ['bubble', 'flame'], name: 'おんせんスライム', note: 'タオルをのせて、いつもいいきぶん' },
    kabuto:   { line: 'fire',  stage: 4, income: 300,   power: 700,  recipe: ['magma', 'ice'], name: 'かぶとスライム', note: 'てつのかぶとで、とてもがんじょう' },
    pearl:    { line: 'grass', stage: 4, income: 500,   power: 900,  recipe: ['flower', 'sea'], name: 'しんじゅスライム', note: 'うみのそこでひかる、たからもの' },
    yuki:     { line: 'grass', stage: 4, income: 400,   power: 800,  recipe: ['mushroom', 'ice'], name: 'ゆきスライム', note: 'ぼうしをかぶって、ふゆをまっている' },
    star:     { line: 'fire',  stage: 4, income: 1000,  power: 1500, recipe: ['sun', 'thunder'], name: 'ほしスライム', note: 'よるになると、きらりとひかる' },
    // 2026-09-17 追加の合成6種（4段階目4つ・5段階目2つ）。くも・ほたる・ほし は てんくう の野生でも出る
    sakura:   { line: 'grass', stage: 4, income: 350,   power: 800,  recipe: ['flower', 'ice'], name: 'さくらスライム', note: 'はるかぜでひらひら。こおりの上でもさく' },
    cloud:    { line: 'water', stage: 4, income: 380,   power: 820,  recipe: ['sea', 'sun'], name: 'くもスライム', note: 'うみが たいようで あたためられて うまれた。ふわふわ' },
    hotaru:   { line: 'grass', stage: 4, income: 420,   power: 850,  recipe: ['mushroom', 'thunder'], name: 'ほたるスライム', note: 'よるになると おしりが ぴかぴか ひかる' },
    sango:    { line: 'water', stage: 4, income: 360,   power: 780,  recipe: ['sea', 'magma'], name: 'さんごスライム', note: 'マグマが うみで ひえて さんごになった' },
    dragon:   { line: 'fire',  stage: 5, income: 4000,  power: 8000, recipe: ['kabuto', 'star'], name: 'ドラゴンスライム', note: 'ちいさな つばさで そらをとぶ。ほのおの なかで いちばんつよい' },
    fairy:    { line: 'grass', stage: 5, income: 6000,  power: 6000, recipe: ['pearl', 'sakura'], name: 'ようせいスライム', note: 'はなびらの はねで ひらひら。しあわせを はこぶ' },
    // 9/17 夜の「合成台の追加を5匹」＋「1匹だけ めちゃ強」。ほうせき は かぶと＋しんじゅ の5段階目、ぎんが は にじ＋ドラゴン で
    // ドラゴンの約4倍（30,000）。ぎんが3匹＋控えで 13.5万＝転生なしで ボス45 まで届く（41体目以降は転生のかけら前提だったのを緩める）
    himawari: { line: 'grass', stage: 4, income: 450,   power: 880,  recipe: ['flower', 'sun'], name: 'ひまわりスライム', note: 'いつも たいようの ほうを むいて にこにこ' },
    kabocha:  { line: 'grass', stage: 4, income: 480,   power: 860,  recipe: ['mushroom', 'yakiimo'], name: 'かぼちゃスライム', note: 'ほくほくの かぼちゃ。ハロウィンが まちどおしい' },
    aurora:   { line: 'water', stage: 4, income: 520,   power: 920,  recipe: ['ice', 'thunder'], name: 'オーロラスライム', note: 'よぞらに ひかりの カーテンを ひろげる' },
    arashi:   { line: 'water', stage: 4, income: 400,   power: 950,  recipe: ['sea', 'thunder'], name: 'あらしスライム', note: 'ざあざあ ごろごろ。かぜを おこして あそぶ' },
    houseki:  { line: 'fire',  stage: 5, income: 3000,  power: 4000, recipe: ['kabuto', 'pearl'], name: 'ほうせきスライム', note: 'かたい かぶとの なかで ほうせきが そだった。きらきら' },
    ginga:    { line: 'none',  stage: 5, income: 20000, power: 30000, recipe: ['rainbow', 'dragon'], name: 'ぎんがスライム', note: 'にじと ドラゴンが ひとつになった。ぎんがの ちからで なんでも ふきとばす。うちゅうじんと あわせると…？' },
    // 2026-09-17 夜「宇宙人と銀河スライムで神様になるようにして」: うちゅうじん（ボス50のあとの うちゅう でしか会えない）＋ ぎんが のレシピ。
    // 材料が最後の のはら の子なのでボスの並びには効かず、図鑑の最後を飾る子。つよさ 100,000・収入 60,000 で全種のいちばん上
    kamisama: { line: 'none',  stage: 5, income: 60000, power: 100000, recipe: ['alien', 'ginga'], name: 'かみさまスライム', note: 'うちゅうじんと ぎんがが ひとつになった、すべてのスライムの かみさま。だれよりも つよくて やさしい' },
    // 2026-09-17 夜「天空の種類も増やして」: てんくう の野生でしか会えない むぞくせい の3種。かぜ → つき → てんし と重ねて進化する（相性なし）
    kaze:     { line: 'none',  stage: 3, income: 250,   power: 600,  evolve: 'tsuki', name: 'かぜスライム', note: 'てんくうの かぜに のって ふわふわ とんでくる' },
    tsuki:    { line: 'none',  stage: 4, income: 800,   power: 1400, evolve: 'tenshi', name: 'つきスライム', note: 'よるの てんくうで しずかに ひかる。いつも ねむそう' },
    tenshi:   { line: 'none',  stage: 5, income: 5000,  power: 7000, name: 'てんしスライム', note: 'しろい はねと わっかで てんくうを まもっている' },
    // 2026-09-17 夜「探検モードを追加して。そこでしかいないスライムも作って」「取れた場所によって属性を付けて」:
    // ボス30で開く たんけん の行き先3つでしか会えない子。系統は行き先の土地から（くらい もり＝くさ・ふるい いせき＝ほのお・
    // たからの どうくつ＝みず）。進化しない・タマゴにもならない。
    // 9/18「探検で手に入るキャラを全部3つずつにして」で行き先ごとに 1種 → 3種（ふつう・めずらしい・とてもめずらしい の順。TANKEN_DESTS の finds）。
    // つよさは にじ（5,000）〜どせい（10,000）の並び。いちばん つよい にんぎょ でも 3匹＋控えで 4.5万 なので、41体目（75,000）からは たんけんの子だけでは飛ばせない
    obake:    { line: 'grass', stage: 3, income: 1000,  power: 2500,  tanken: 'mori',    name: 'おばけスライム', note: 'くらい もりに すむ。こわがりだけど、なかよくなると いつも そばにいる' },
    koumori:  { line: 'grass', stage: 3, income: 1400,  power: 3500,  tanken: 'mori',    name: 'こうもりスライム', note: 'くらい もりの きの えだに、さかさまに ぶらさがって ねている。よるが だいすき' },
    fukurou:  { line: 'grass', stage: 3, income: 1800,  power: 4500,  tanken: 'mori',    name: 'ふくろうスライム', note: 'もりの ものしり。まっくらでも なんでも 見えるので、みちに まよわない' },
    golem:    { line: 'fire',  stage: 4, income: 2500,  power: 5000,  tanken: 'iseki',   name: 'ゴーレムスライム', note: 'いせきを まもっていた いしの スライム。ひびから ほのおが もれている' },
    miira:    { line: 'fire',  stage: 4, income: 3000,  power: 6000,  tanken: 'iseki',   name: 'ミイラスライム', note: 'いせきの おくで ずっと ねむっていた。ほうたいが ほどけると はずかしがる' },
    sphinx:   { line: 'fire',  stage: 4, income: 3500,  power: 7000,  tanken: 'iseki',   name: 'スフィンクススライム', note: 'いせきの もんばん。なぞなぞに こたえると なかまになってくれる' },
    mimic:    { line: 'water', stage: 5, income: 5000,  power: 8000,  tanken: 'dokutsu', name: 'ミミックスライム', note: 'どうくつの たからばこに ばけている。あけると とびだして なかまになる' },
    crystal:  { line: 'water', stage: 5, income: 5500,  power: 9000,  tanken: 'dokutsu', name: 'クリスタルスライム', note: 'どうくつの けっしょうが スライムになった。ひかりを あてると にじいろに きらめく' },
    ningyo:   { line: 'water', stage: 5, income: 6000,  power: 10000, tanken: 'dokutsu', name: 'にんぎょスライム', note: 'どうくつの ちかこに すんでいる。うたが とても じょうずで、きくと げんきになる' },
    // 2026-09-17 夜「ボス50で宇宙をつくって しゅるいは5しゅ類ぐらい」: ボス50のあとに開く のはら「うちゅう」の野生でしか会えない むぞくせい の5種。
    // いんせき → すいせい → ブラックホール と重ねて進化。どせい・うちゅうじん は単独。ぎんが（30,000）より弱くしておく
    inseki:   { line: 'none',  stage: 3, income: 1500,  power: 3000,  evolve: 'suisei', name: 'いんせきスライム', note: 'そらから おちてきた。ごつごつして あつい' },
    suisei:   { line: 'none',  stage: 4, income: 4000,  power: 9000,  evolve: 'blackhole', name: 'すいせいスライム', note: 'ながい しっぽを ひいて びゅーん' },
    dosei:    { line: 'none',  stage: 4, income: 6000,  power: 10000, name: 'どせいスライム', note: 'おおきな わっかが じまん。くるくる まわる' },
    blackhole:{ line: 'none',  stage: 5, income: 12000, power: 25000, name: 'ブラックホールスライム', note: 'なんでも すいこむ。おなかは いつも ぺこぺこ' },
    alien:    { line: 'none',  stage: 5, income: 25000, power: 20000, name: 'うちゅうじんスライム', note: 'とおい ほしから きた。ことばは つうじないけど なかよし' },
    rainbow:  { line: 'none',  stage: 5, income: 10000, power: 5000, recipe: ['pearl', 'star'], name: 'にじスライム', note: 'すべての色をもつ スライム。ドラゴンと あわせると…？' },
    oyabun:   { line: 'none',  stage: 4, income: 1000,  power: 1500, mutation: true, name: 'おやぶんスライム', note: 'とつぜんへんいでしか生まれない、みんなのおやぶん。つよさは 見つけた いちばんつよい子の 2ばい' }
  };
  var ORDER = ['green', 'leaf', 'bud', 'flower', 'mushroom', 'blue', 'bubble', 'wave', 'sea', 'ice',
    'red', 'flame', 'magma', 'sun', 'thunder', 'ajisai', 'yakiimo', 'onsen', 'kabuto', 'pearl', 'yuki', 'star',
    'sakura', 'cloud', 'hotaru', 'sango', 'himawari', 'kabocha', 'aurora', 'arashi', 'dragon', 'fairy', 'houseki',
    'kaze', 'tsuki', 'tenshi', 'obake', 'koumori', 'fukurou', 'golem', 'miira', 'sphinx', 'mimic', 'crystal', 'ningyo', 'inseki', 'suisei', 'dosei', 'blackhole', 'alien', 'rainbow', 'ginga', 'kamisama', 'oyabun'];

  // 系統ごとの1〜3段階目（タマゴ・野生・ボスで使う）
  var LINE_BASE = { grass: ['green', 'leaf', 'bud'], water: ['blue', 'bubble', 'wave'], fire: ['red', 'flame', 'magma'] };
  // のはら の野生の枠（Lv1→2→3 の3枠。枠の中の種類は同じ確率で出る）。系統の のはら は LINE_BASE の1種ずつ、てんくう は pool の2種ずつ
  function areaPool(a) { return AREAS[a].pool || LINE_BASE[AREAS[a].line].map(function (k) { return [k]; }); }
  // 枠のどれか1種でも図鑑にあれば、その のはら の Lv を上げられる
  function slotFound(slot) { return slot.some(function (k) { return !!S.dex[k]; }); }
  var LINE_NAME = { grass: 'くさ', water: 'みず', fire: 'ほのお', none: 'むぞくせい' };

  // レシピの逆引き（'leaf+bubble' → 'ajisai'。キーは名前順にそろえて順不同にする）
  var RECIPES = {};
  var RECIPE_LIST = [];
  ORDER.forEach(function (k) {
    var r = SPECIES[k].recipe;
    if (!r) return;
    RECIPES[recipeKey(r[0], r[1])] = k;
    RECIPE_LIST.push(k);
  });
  function recipeKey(a, b) { return a < b ? a + '+' + b : b + '+' + a; }

  // 進化の逆引き（'flower' → { from: 'bud', need: 'flowerbed', other: 'mushroom' }）。図鑑の入手方法で使う
  var EVOLVE_FROM = {};
  ORDER.forEach(function (k) {
    var e = SPECIES[k].evolve;
    if (!e) return;
    if (typeof e === 'string') { EVOLVE_FROM[e] = { from: k }; return; }
    e.forEach(function (b, i) { EVOLVE_FROM[b.to] = { from: k, need: b.need, other: e[1 - i].to }; });
  });

  // のはら。ボスを倒した数で開く
  var AREAS = {
    grass: { name: 'くさはら', line: 'grass', unlockBoss: 0 },
    water: { name: 'みずべ', line: 'water', unlockBoss: 10 },
    fire:  { name: 'かざん', line: 'fire', unlockBoss: 20 },
    // てんくう は系統を持たない のはら。野生は Lv の枠ごとに「合成でしか会えない子」と「てんくうにしかいない子」が半々で出る。タマゴは無い
    sky:   { name: 'てんくう', line: 'none', unlockBoss: 40, pool: [['cloud', 'kaze'], ['hotaru', 'tsuki'], ['star', 'tenshi']] },
    // うちゅう はボス50（最後）を倒したあとの のはら。ボスは無いので、図鑑を埋める・つよい子を捕まえるのが目的
    space: { name: 'うちゅう', line: 'none', unlockBoss: 50, pool: [['inseki'], ['suisei', 'dosei'], ['blackhole', 'alien']] }
  };
  var AREA_ORDER = ['grass', 'water', 'fire', 'sky', 'space'];

  // ---- たんけん（ボス30体で開く4つ目の場面）----
  // 2026-09-17 夜「ぼくじょう・野原・討伐以外に 探検モードを追加して。そこでしかいないスライムも作って、探検モードはボス30から」。
  // 行き先を1つえらんで、つよさ上位3匹（とうばつと同じ えらび方）を送り出す。待つあいだも牧場は動く。
  // 帰ってくると コイン（いまの秒収入 × 時間 × TANKEN_COIN_RATE）と、その行き先でしか会えない子が rate の確率で見つかる。
  // 見つかるときは finds の3種（ふつう・めずらしい・とてもめずらしい）から TANKEN_FIND_W の重みでえらぶ。まだ図鑑にない子は重み2倍
  //（9/18「探検で手に入るキャラを全部3つずつにして」。それまでは行き先ごとに1種）。
  // need はその確率が最大になる つよさ（下回るぶん 0.3〜1 に縮む）。TANKEN_PITY 回つづけて外れたら次は かならず見つかる
  // 所要時間は 9/18「探検に行く時間を短くして」で 5分/30分/2時間 → 1分/5分/15分（10分遊ぶ子でも もり・いせき は同じ回に帰ってくる。コインは時間に比例するので損はしない）
  var TANKEN_UNLOCK_BOSS = 30, TANKEN_COIN_RATE = 0.5, TANKEN_PITY = 2, TANKEN_FIND_W = [5, 3, 2];
  var TANKEN_DESTS = [
    { id: 'mori', name: 'くらい もり', icon: '🌲', bg: 'bg_tk_mori', ms: 1 * 60000, need: 6000, finds: ['obake', 'koumori', 'fukurou'], rate: 0.4, col: ['#0f2a33', '#245a4a'],
      ev: ['ひかる キノコの みちを 見つけた', 'どこかから ふしぎな こえが…', 'おおきな 木の うろを のぞいてみた'] },
    { id: 'iseki', name: 'ふるい いせき', icon: '🏛️', bg: 'bg_tk_iseki', ms: 5 * 60000, need: 12000, finds: ['golem', 'miira', 'sphinx'], rate: 0.45, col: ['#ffd9a0', '#e0b070'],
      ev: ['くずれた かべの もようを しらべた', 'かくし とびらを 見つけた！', 'ゆかの したから ゴトゴト おとがする'] },
    { id: 'dokutsu', name: 'たからの どうくつ', icon: '💎', bg: 'bg_tk_dokutsu', ms: 15 * 60000, need: 24000, finds: ['mimic', 'crystal', 'ningyo'], rate: 0.5, col: ['#1d1650', '#2f2a7a'],
      ev: ['キラキラの けっしょうが ならんでいる', 'コインの やまを 見つけた！', 'おくに たからばこが…！'] }
  ];
  function tankenDest(id) {
    for (var i = 0; i < TANKEN_DESTS.length; i++) if (TANKEN_DESTS[i].id === id) return TANKEN_DESTS[i];
    return TANKEN_DESTS[0];
  }
  var LINE_ORDER = ['grass', 'water', 'fire'];   // タマゴがある系統（てんくう にタマゴは無い）

  // 施設。cost は「今の秒収入 × secs 秒」と floor の大きい方（秒収入に比例させて、いつ買っても数分ぶんの重さにする）。
  // mult は収入倍率（全部で ×54）、need は買えるようになる条件
  var FACILITIES = [
    { id: 'scarecrow', name: 'かかし', icon: '🌾', mult: 1.5, secs: [600], floor: 150, desc: 'しゅうにゅう ×1.5' },
    { id: 'nest', name: 'すみか', icon: '🏠', secs: [60, 900, 2700], floor: 300, need: { stage2: true }, desc: '親2匹を入れるとタマゴが生まれる（Lvで組が増える）' },
    { id: 'flowerbed', name: '花だん', icon: '🌷', mult: 2, secs: [900], floor: 1200, need: { dex: 'bud' }, desc: 'しゅうにゅう ×2 ／ エサ「はなのみつ」（つぼみ → はな）' },
    { id: 'log', name: 'まるた', icon: '🪵', secs: [300], floor: 800, need: { dex: 'bud' }, desc: 'エサ「きのこ」（つぼみ → きのこ）' },
    { id: 'netHut', name: 'あみごや', icon: '🎣', secs: [600, 1200, 2400], floor: 400, need: { caught: 3 }, desc: 'あみの最大数が増えて、回復が早くなる' },
    { id: 'gousei', name: 'ごうせい台', icon: '🧪', secs: [300], floor: 3000, need: { area: 'water' }, desc: '違う種類を2匹かけ合わせて合成できる' },
    { id: 'well', name: '井戸', icon: '🪣', mult: 2, secs: [900], floor: 5000, need: { dex: 'wave' }, desc: 'しゅうにゅう ×2 ／ エサ「わきみず」（なみ → うみ）' },
    { id: 'icehouse', name: 'こおりのいえ', icon: '🧊', secs: [300], floor: 3000, need: { dex: 'wave' }, desc: 'エサ「こおりのみ」（なみ → こおり）' },
    { id: 'spring', name: 'ふしぎな泉', icon: '⛲', secs: [900, 1800, 2700], floor: 4000, need: { dexCount: 6 }, desc: 'とつぜんへんいが出やすくなる' },
    { id: 'auto', name: 'おまかせ進化', icon: '🤖', secs: [900, 2700], floor: 5000, need: { merges: 30 }, desc: 'Lv1 まとめて進化ボタン ／ Lv2 30秒ごとに自動で進化' },
    { id: 'windmill', name: '風車', icon: '🎡', mult: 3, secs: [1800], floor: 60000, need: { area: 'water' }, desc: 'しゅうにゅう ×3' },
    { id: 'mirror', name: 'かがみ', icon: '🪞', secs: [300], floor: 30000, need: { dex: 'magma' }, desc: 'エサ「ひかりのつぶ」（マグマ → たいよう）' },
    { id: 'rod', name: 'ひらいしん', icon: '⚡', secs: [300], floor: 30000, need: { dex: 'magma' }, desc: 'エサ「でんきのみ」（マグマ → かみなり）' },
    { id: 'bridge', name: 'にじの橋', icon: '🌈', mult: 3, secs: [1800], floor: 800000, need: { area: 'fire' }, desc: 'しゅうにゅう ×3' }
  ];
  var FAC_BY_ID = {};
  FACILITIES.forEach(function (f) { FAC_BY_ID[f.id] = f; });

  // エサ。枝分かれの施設でできる（id は施設と同じ）。
  // つぼみ・なみ・マグマに何を食べさせたかで、4段階目のどちらに進化するかが決まる
  var FOODS = [
    { id: 'flowerbed', name: 'はなのみつ', icon: '🍯' },
    { id: 'log', name: 'きのこ', icon: '🍄' },
    { id: 'well', name: 'わきみず', icon: '💧' },
    { id: 'icehouse', name: 'こおりのみ', icon: '❄️' },
    { id: 'mirror', name: 'ひかりのつぶ', icon: '☀️' },
    { id: 'rod', name: 'でんきのみ', icon: '⚡' }
  ];
  var FOOD_BY_ID = {};
  FOODS.forEach(function (f) { FOOD_BY_ID[f.id] = f; });

  var MIN_SIZE = 4;
  var MAX_SIZE = 7;
  var EXPAND_FLOOR = [2000, 40000, 800000];  // 4→5, 5→6, 6→7
  var RANCH2_FLOOR = 3000000;                // 7×7 のあとの「ぼくじょう２」（6→7 の約4倍。秒収入 600 秒ぶんと高いほう）
  var WILD_MAX = 6;
  var SPAWN_MS = 30 * 1000;
  var NET_BASE_MAX = 8;                      // 5本だと、最初の10分で5匹捕まえるのに中央12分かかった
  var NET_HUT_MAX = [8, 9, 10, 12];
  var NET_HUT_REGEN = [60, 45, 30, 20];     // 秒
  var NET_LV_MAX = 5;
  var RING_LAP_MS = 1200;
  var OFFLINE_CAP_MS = 8 * 60 * 60 * 1000;
  var OFFLINE_RATE = 0.5;
  var PET_RATE = 0.05;
  var TAP_CAP_PER_SEC = 20;
  var BATTLE_MS = 10000;
  var SWEEP_MS = 1400;      // 「きあい」ゲージが1往復する時間。タップは1往復に1回だけ効く（連打対策）
  var CRIT_HALF = 0.08;     // まんなかからこの範囲がみどりの窓＝かいしんのいちげき
  var CHARGE_MS = 1600;     // おやぶんの「きあいため」。この間にかいしんを当てるとくじける
  var BENCH_RATE = 0.02;    // 戦いに出ない子のおうえん（1匹あたり）
  var BENCH_CAP = 0.5;
  var BOSS_COUNT = 50;
  // 31体目からの ぬし は、時間をおいて1体ずつ やってくる（BOSS_STOCK_MAX 体までは待っていてくれる）。
  // シミュ(9/18)で、1日ぶっ通しの子が 31→50体目を同じ日のうちに抜けた。つよさの表を上げても転生のかけらで追い抜かれるので、時間で間をあける。
  // 3時間×2体なら ぶっ通しの子は4日・毎日30分の子は 7日→13日・平日10分の子は 12日→22日。
  // 公開初日は3時間で出したが「3時間待つのは長い」と声があり、9/19 に1時間へ（2体たまるのは同じ）。
  // へるのは はじめて たおしたときだけ（まけても ぬし は帰らない）。50体たおしたあとの再挑戦には かけない
  var BOSS_WAIT_FROM = 30;
  var BOSS_STOCK_MAX = 2;
  var BOSS_REGEN_MS = 60 * 60 * 1000;
  var SHINY_INCOME = 3;
  var SHINY_POWER = 1.5;
  var EGG_CPS_SECS = { grass: 0, water: 3600, fire: 10800 };  // タマゴの値段の下限（eggPrice）
  var EGG_CPS_FREE = 2;

  // お世話。最後になでた・エサをあげた時刻からの時間で4段階に弱る。
  // 3時間でふつう（8割）・10時間でしょんぼり（半分）・2日でやさぐれ（4分の1）。
  // 9/18「今の半分の時間で弱っていくようにして」で 6/20/96時間 → 3/10/48時間。毎日来る子は毎回 しょんぼり、週末あけの子は やさぐれ に会う。
  // 留守の稼ぎには効かないので、来たら「みんなにごはん」（1分ぶんの収入）で戻す用事が毎回できるだけ。
  // 同日「ふつうとごきげんも分けて」: それまで ふつう は名前だけの違い（×1・印なし）だったのを ×0.8 と 💤 の印にして、案内も段階ごとに数える。
  // （9/16 の元の根拠）24時間ではなく20時間にしたのは、24時間ちょうどだと「毎日だいたい同じ時刻に来る子」がしょんぼりに一度も会わなかったため
  // （シミュ200シード。20時間なら毎日必ず1回お世話の用事ができて、合格ラインは24時間とまったく同じだった）。
  // 死なない・逃げない・しょんぼりでも重ねて進化できる（牧場が詰まる原因を増やさないため）。
  // ★留守中の稼ぎには効かせない: シミュで留守の稼ぎまで半分にすると、平日10分の子のボス30体が33日になり公開の基準を割った
  var CARE_STEPS = [0, 3 * 3600000, 10 * 3600000, 48 * 3600000];
  var CARE_NAME = ['ごきげん', 'ふつう', 'しょんぼり', 'やさぐれ'];
  var CARE_MULT = [1, 0.8, 0.5, 0.25];
  var CARE_MARK = ['', '💤', '💧', '💢'];
  var FOOD_SECS = 120;   // 施設1つにつき、このあいだに1つできる
  var FOOD_MAX = 10;

  // ---- 表の見出しの差しかえ（英語版）----
  // key（green・scarecrow…）は保存データとレシピの照合に使うので絶対に触らない。
  // 差しかえるのは画面に出る name / note / desc / ev だけ。
  // 54種ぶんを1行ずつ TEXT.spGreen のように書くと表が読めなくなるので、表ごとまとめて受け取る
  if (TEXT.species) {
    ORDER.forEach(function (k) {
      var v = TEXT.species[k];
      if (!v || !SPECIES[k]) return;
      SPECIES[k].name = v[0];
      SPECIES[k].note = v[1];
    });
  }
  if (TEXT.areas) {
    AREA_ORDER.forEach(function (a) { if (TEXT.areas[a]) AREAS[a].name = TEXT.areas[a]; });
  }
  if (TEXT.facilities) {
    FACILITIES.forEach(function (f) {
      var v = TEXT.facilities[f.id];
      if (!v) return;
      f.name = v[0];
      f.desc = v[1];
    });
  }
  if (TEXT.foods) {
    FOODS.forEach(function (f) { if (TEXT.foods[f.id]) f.name = TEXT.foods[f.id]; });
  }
  if (TEXT.dests) {
    TANKEN_DESTS.forEach(function (d) {
      var v = TEXT.dests[d.id];
      if (!v) return;
      d.name = v.name;
      if (v.ev) d.ev = v.ev;
    });
  }
  if (TEXT.lineNames) {
    Object.keys(TEXT.lineNames).forEach(function (k) { LINE_NAME[k] = TEXT.lineNames[k]; });
  }
  if (TEXT.careNames) CARE_NAME = TEXT.careNames;

  // ============================================
  // 式
  // ============================================

  // 1匹＝1つの文字列。"leaf" / "leaf!"（きらきら）/ "bud^0@29420640"（エサで決めた進化先＋最後にお世話した時刻）。
  // マスを文字列で持つと保存データが小さく、すみか・ごうせい台へ移してもそのまま持ち回れる。
  // ^n は SPECIES.evolve の何番目か。公開後に evolve の並びを変えると、保存ずみの指定先が変わるので変えないこと。
  // @m は「お世話した時刻」を分にしたもの（分で十分・桁を短くするため）
  var SLIME_RE = /^([a-z]+)(!?)(?:\^(\d))?(?:@(\d+))?$/;
  function parseSlime(s) {
    if (!s || typeof s !== 'string') return null;
    var m = SLIME_RE.exec(s);
    if (!m || !SPECIES[m[1]]) return null;
    return { k: m[1], shiny: m[2] === '!', mark: m[3] ? +m[3] : -1, care: m[4] ? +m[4] * 60000 : 0 };
  }
  function slimeStr(k, shiny, mark, careAt) {
    return k + (shiny ? '!' : '') + (mark >= 0 ? '^' + mark : '') + (careAt > 0 ? '@' + Math.floor(careAt / 60000) : '');
  }
  // 1匹の一部だけ差しかえる（mark / care）
  function reSlime(str, mark, careAt) {
    var s = parseSlime(str);
    if (!s) return str;
    return slimeStr(s.k, s.shiny, mark != null ? mark : s.mark, careAt != null ? careAt : s.care);
  }

  // ごきげん 0 → ふつう 1 → しょんぼり 2 → やさぐれ 3
  function moodLevel(careAt, t) {
    var d = t - (careAt || 0);
    for (var i = CARE_STEPS.length - 1; i > 0; i--) if (d >= CARE_STEPS[i]) return i;
    return 0;
  }
  function moodMult(careAt, t) { return CARE_MULT[moodLevel(careAt, t)]; }
  // エサで決めた進化先（まだ決めていない・進化先が1つしかない種類なら ''）
  function markTarget(s) {
    var e = s && SPECIES[s.k].evolve;
    return s && s.mark >= 0 && e && typeof e !== 'string' && e[s.mark] ? e[s.mark].to : '';
  }
  // そのエサが、この種類のどちらの進化先を決めるか（決めないなら -1）
  function foodBranch(k, foodId) {
    var e = SPECIES[k].evolve;
    if (!e || typeof e === 'string') return -1;
    for (var i = 0; i < e.length; i++) if (e[i].need === foodId) return i;
    return -1;
  }

  function incomeOf(k, shiny) { return SPECIES[k].income * (shiny ? SHINY_INCOME : 1); }
  // おやぶんスライム は「みんなのおやぶん」なので、つよさは 図鑑で見つけた いちばんつよい子（とつぜんへんい以外）の2倍にする（9/17 夜「親分スライムの強さをあげて」）。
  // 固定で上げると序盤に運よく生まれた子がボス20台まで一気に抜けてしまうので、表の 1,500 は下限に残し、
  // ほし(1,500)で 3,000・ドラゴン(8,000)で 16,000・ぎんが で上限の 30,000（ぎんが と並ぶ。追い越さない。かみさま(100,000)は最後の のはら のあとの子なので上限は上げない）
  var OYABUN_MULT = 2, OYABUN_CAP = 30000;
  function speciesPower(k) {
    if (k !== 'oyabun') return SPECIES[k].power;
    var best = 0;
    Object.keys(S.dex).forEach(function (d) { if (SPECIES[d] && !SPECIES[d].mutation) best = Math.max(best, SPECIES[d].power); });
    return Math.max(SPECIES.oyabun.power, Math.min(OYABUN_CAP, best * OYABUN_MULT));
  }
  function powerOf(k, shiny, shards) { return speciesPower(k) * (shiny ? SHINY_POWER : 1) * (1 + 0.1 * (shards || 0)); }

  function facMult(fac) {
    var m = 1;
    FACILITIES.forEach(function (f) { if (f.mult && fac[f.id]) m *= f.mult; });
    return m;
  }

  // 秒収入。cells は牧場のマスの文字列配列。
  // t（いまの時刻）を渡すとごきげんが効く。渡さないと元気なときの値＝留守の稼ぎと、施設・タマゴの値段の基準に使う
  // （わざと弱らせて値段を下げる抜け道をふさぐ）
  function calcCps(cells, fac, shards, t) {
    var base = 0;
    for (var i = 0; i < cells.length; i++) {
      var s = parseSlime(cells[i]);
      if (s) base += incomeOf(s.k, s.shiny) * (t ? moodMult(s.care, t) : 1);
    }
    return base * facMult(fac) * (1 + 0.1 * (shards || 0));
  }

  function scaledCost(cpsBase, sec, floor) { return Math.ceil(Math.max(floor, cpsBase * sec)); }

  // 一律8がけ（2026-09-16）。進化の施設ゲートを外したあとも「建てるまで遠い」感じが残っていたため
  function facilityCost(f, lv, cpsBase) {
    return Math.ceil(scaledCost(cpsBase, f.secs[lv], f.floor * Math.pow(3, lv)) * 0.8);
  }

  // タマゴ: 孵る種類の20秒ぶんの収入 × 1.05^(その系統で買った数)。
  // みず・ほのおは3個目から「いまの秒収入 × EGG_CPS_SECS 秒」も下回らない。にじ・おやぶんの収入だとタマゴがただ同然になり、
  // 買っては合成するだけで一気に進んでしまうため。くさ（最初の10分）と、のはらを開いてすぐの2個はそのままの値段
  function eggSpecies(line, eggLv) { return LINE_BASE[line][Math.min(eggLv, 3) - 1]; }
  function eggPrice(line, eggLv, bought, cpsBase) {
    var n = bought || 0, grow = Math.pow(1.05, n);
    var p = Math.ceil(SPECIES[eggSpecies(line, eggLv)].income * 20 * grow);
    if (n >= EGG_CPS_FREE && EGG_CPS_SECS[line]) p = Math.max(p, Math.ceil((cpsBase || 0) * EGG_CPS_SECS[line] * grow));
    return p;
  }
  // タマゴLvアップ: 次の段階のいちばん安い種類の1200秒ぶん。240秒だとLv3を急いで高いタマゴしか買えなくなり、レシピや図鑑が遅れた
  function eggLvCost(eggLv) { return SPECIES[LINE_BASE.grass[eggLv]].income * 1200; }

  function netMax(hutLv) { return NET_HUT_MAX[hutLv || 0]; }
  function netRegenMs(hutLv) { return NET_HUT_REGEN[hutLv || 0] * 1000; }
  function netPrice(cpsBase, bought) { return Math.ceil(Math.max(30, cpsBase * 30) * Math.pow(1.05, bought || 0)); }
  function netLvCost(netLv, cpsBase) { return scaledCost(cpsBase, 240, 200 * Math.pow(4, netLv - 1)); }
  function areaLvCost(lv, cpsBase) { return lv === 1 ? scaledCost(cpsBase, 300, 500) : scaledCost(cpsBase, 900, 4000); }
  function expandCost(size, cpsBase) { return scaledCost(cpsBase, 300, EXPAND_FLOOR[size - MIN_SIZE]); }
  function ranch2Cost(cpsBase) { return scaledCost(cpsBase, 600, RANCH2_FLOOR); }

  // 捕獲リングの緑の範囲（1周に対する割合）
  function catchZone(stage, shiny, netLv) {
    var base = [0, 0.5, 0.3, 0.16, 0.11, 0.09][Math.min(stage, 5)];
    var z = Math.min(0.9, base + 0.08 * ((netLv || 1) - 1));
    return shiny ? z / 2 : z;
  }
  // リング1周の速さ。段階が上がるごとに8%・のはらLvが上がるごとに5%速い（1段階目・Lv1 は 1200ms のまま。4段階目のLv3で 820ms）
  function catchLapMs(stage, areaLv) {
    return Math.round(RING_LAP_MS * (1 - 0.08 * (Math.min(stage, 5) - 1)) * (1 - 0.05 * (Math.min(areaLv || 1, 3) - 1)));
  }
  // リング開始から elapsedMs 後のタップが緑に入っているか。zoneStart も1周に対する割合
  function catchHit(elapsedMs, zoneStart, zone, lapMs) {
    var f = (elapsedMs / (lapMs || RING_LAP_MS)) % 1;
    var d = (f - zoneStart + 1) % 1;
    return d <= zone;
  }

  // 野生の段階の出方（のはら Lv 別）
  var WILD_STAGE_RATES = { 1: [0.9, 0.1, 0], 2: [0.6, 0.4, 0], 3: [0.45, 0.35, 0.2] };
  // さくらスライムを見つけたあとの くさはら は「さくらの くさはら」（絵も変わる: fieldBgKey）。野生の3割は段階に関係なく さくら が出る
  var SAKURA_RATE = 0.3;
  function sakuraField(a) { return a === 'grass' && !!(S && S.dex && S.dex.sakura); }
  function rollWild(a, areaLv, rnd) {
    rnd = rnd || Math.random;
    if (sakuraField(a) && rnd() < SAKURA_RATE) return slimeStr('sakura', rnd() < 0.01);
    var rates = WILD_STAGE_RATES[Math.min(areaLv, 3)];
    var r = rnd(), idx = 0;
    while (idx < 2 && r >= rates[idx]) { r -= rates[idx]; idx++; }
    var slot = areaPool(a)[idx];
    return slimeStr(slot[Math.floor(rnd() * slot.length)], rnd() < 0.01);
  }

  // 同じ種類2匹の進化先の候補（施設の条件を満たすものだけ）。進化しない種類は []
  // 進化先の候補。施設を持っていなくても、同じ種類を重ねれば必ず進化する。
  // どちらの枝になるかは エサ → 覚えた好み → 「どっちに進化する？」の順で決める（branchFor）
  function evolveOptions(k) {
    var e = SPECIES[k].evolve;
    if (!e) return [];
    if (typeof e === 'string') return [e];
    return e.map(function (b) { return b.to; });
  }

  function shinyRate(springLv) { return 0.02 + 0.03 * (springLv || 0); }
  function oyabunRate(springLv) { return 0.01 + 0.005 * (springLv || 0); }
  // すみかのきらきら遺伝
  function breedShinyRate(shinyParents, springLv) {
    return [0.02, 0.1, 0.5][shinyParents] + 0.03 * (springLv || 0);
  }
  // すみかでタマゴが生まれるまで（親の段階ごとの秒。おやぶんは段階5扱い）。
  // 1〜2段階目は最初の10分で「産ませる」を見せられる短さ、3段階目からは留守中に進む長さ（計画書 2.9 のシミュで決めた値）
  var BREED_SECS = [60, 180, 3600, 5400, 7200];
  function breedMs(a, b) {
    var st = Math.max(SPECIES[a].stage, SPECIES[b].stage);
    if (a === 'oyabun' || b === 'oyabun') st = 5;
    return BREED_SECS[st - 1] * 1000;
  }

  // ボスのつよさ。味方のつよさは種類だけで決まるので、式（30×1.25^n）ではなく「そのころ何を何匹そろえられるか」の段に合わせた表にする。
  // 式のままだと、次のボスまでの待ちが0日か5日超のどちらかに分かれた。
  // くさ: 7体目から はな/きのこ 2〜3匹 / みず: ゆき・しんじゅ 1→3匹 / ほのお: しんじゅ→ほし1〜3→にじ1〜3。
  // ほのお1体目（21体目）が20体目より弱いのは、かざんが開いた直後に6〜11日の待ちが出たため
  var BOSS_POWER = [
    30, 40, 54, 72, 97, 130, 330, 390, 440, 490,
    550, 700, 1000, 1400, 1900, 2400, 2800, 3100, 3400, 3600,
    1600, 2000, 2500, 3000, 3600, 4300, 5100, 7000, 9500, 13500,
    // 31〜40 は にじ を見つけたあとの段。にじ3匹（5000×3）に控えのおうえん（最大 +50%）と かいしん を足した
    // 上限がおよそ 2.5万〜3万なので、36体目まではそれで届き、37〜40体目は ドラゴン（8000）を1匹ずつ足すと届く並びにする
    // （37: にじ2＋ドラゴン1・38: ドラゴン2・39: ドラゴン3・40: ドラゴン3＋かいしん）。
    // もとは 14,500〜65,000 で、36体目（35,000）が にじ3匹では勝てないとユーザー指摘があり引き直した
    // 41〜50 は てんくう の段。もとは転生の かけら（+10%/個）前提だったが、9/17 夜に ぎんが（30,000）を足して
    // ぎんが3匹＋控え＝13.5万 で 45体目まで転生なしで届く。46〜50 は きらきら の ぎんが（1.5倍）で伸ばす並び
    // （46: 控え＋かいしん・47: きらきら1・48: きらきら2・49: きらきら2＋かいしん・50: きらきら2＋かいしん か きらきら3）。
    // もとは 146,000〜260,000（50体目は かけら20個前提）で、ぎんが3匹（きらきら2）では50体目に勝てないとユーザー指摘があり引き直した
    14500, 16500, 18500, 20500, 22500, 24500, 27500, 31000, 35000, 42000,
    75000, 86000, 98000, 112000, 128000, 136000, 148000, 160000, 172000, 185000
  ];

  // 31〜40 は「ぎゃくしゅう」: 4段階目の子が系統をまたいで来るので、そのつどメンバーを入れかえる。
  // 41〜50 は てんくう: 合成でしか会えない子と てんくう の3種（かぜ・つき・てんし＝むぞくせい）。最後は にじ（むぞくせい＝相性なし）
  var BOSS_EXTRA = [
    'flower', 'sea', 'sun', 'mushroom', 'ice', 'thunder', 'ajisai', 'onsen', 'kabuto', 'star',
    'cloud', 'sakura', 'hotaru', 'sango', 'kaze', 'tsuki', 'tenshi', 'dragon', 'fairy', 'rainbow'
  ];

  // 「みどりスライム」→「みどりのぬし」。英語は 'Green Slime' から tx('slimeWord') を落として '{n} Boss' に入れる
  function bossName(speciesName, last) {
    var base = speciesName.replace(tx('slimeWord', 'スライム'), '').trim();
    return last ? tf('bossOyabun', '{n}のおやぶん', { n: base }) : tf('bossNushi', '{n}のぬし', { n: base });
  }

  // ボス50体: のはら3つ × 10体（30体まで。10体目ごとに「〜のおやぶん」）＋ BOSS_EXTRA の20体
  function bossDef(n) {
    if (n >= 30) {
      var xk = BOSS_EXTRA[n - 30], xl = SPECIES[xk].line, last = n % 10 === 9;
      return { n: n, key: xk, line: xl, area: n >= 40 ? 'sky' : xl, stage: SPECIES[xk].stage, power: BOSS_POWER[n],
        name: bossName(SPECIES[xk].name, last) };
    }
    var area = AREA_ORDER[Math.floor(n / 10)];
    var line = AREAS[area].line;
    var k = n % 10;
    var key, name;
    if (k === 9) {
      key = SPECIES[LINE_BASE[line][2]].evolve[0].to;
      name = tf('bossOyabun', '{n}のおやぶん', { n: AREAS[area].name });
    } else {
      key = LINE_BASE[line][Math.min(Math.floor(k / 4), 2)];
      name = bossName(SPECIES[key].name, false);
    }
    return { n: n, key: key, line: line, area: area, name: name, stage: SPECIES[key].stage, power: BOSS_POWER[n] };
  }

  // 相性（3すくみ）: ほのお ＞ くさ ＞ みず ＞ ほのお
  var BEATS = { fire: 'grass', grass: 'water', water: 'fire' };
  function typeMult(att, def) {
    if (att === 'none' || def === 'none') return 1;
    if (BEATS[att] === def) return 1.5;
    if (BEATS[def] === att) return 0.67;
    return 1;
  }
  // m.mood は お世話の倍率（pickParty が入れる）。無ければ元気なときのつよさ
  function teamPower(members, bossLine, shards) {
    var sum = 0;
    members.forEach(function (m) { sum += powerOf(m.k, m.shiny, shards) * (m.mood || 1) * typeMult(SPECIES[m.k].line, bossLine); });
    return sum;
  }

  function shardsFor(lifetime) { return lifetime > 0 ? Math.floor(Math.sqrt(lifetime / 1e7)) : 0; }

  function offlineGain(elapsedMs, cps) {
    if (!(elapsedMs > 0) || !(cps > 0)) return 0;
    return Math.min(elapsedMs, OFFLINE_CAP_MS) / 1000 * cps * OFFLINE_RATE;
  }

  // 大きい数: 12345 → "1.23万"。小数は2桁固定（桁の途中で文字幅が変わってHUDがガタつかないように）
  function fmtBig(n) {
    n = Math.floor(n || 0);
    if (n < 1e4) return n.toLocaleString();
    var units = TEXT.bigUnits || [[1e16, '京'], [1e12, '兆'], [1e8, '億'], [1e4, '万']];
    for (var i = 0; i < units.length; i++) {
      if (n >= units[i][0]) return (n / units[i][0]).toFixed(2) + units[i][1];
    }
    return String(n);
  }
  function fmtTime(ms) {
    var s = Math.max(0, Math.ceil(ms / 1000));
    if (s >= 3600) return Math.floor(s / 3600) + tx('unitHour', '時間') + Math.floor(s % 3600 / 60) + tx('unitMin', '分');
    return Math.floor(s / 60) + ':' + ('0' + s % 60).slice(-2);
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      SPECIES: SPECIES, ORDER: ORDER, RECIPES: RECIPES, FACILITIES: FACILITIES, AREAS: AREAS, FOODS: FOODS,
      CARE_STEPS: CARE_STEPS, CARE_MULT: CARE_MULT, FOOD_SECS: FOOD_SECS, FOOD_MAX: FOOD_MAX,
      moodLevel: moodLevel, moodMult: moodMult, slimeStr: slimeStr, reSlime: reSlime, foodBranch: foodBranch,
      parseSlime: parseSlime, calcCps: calcCps, facilityCost: facilityCost, eggPrice: eggPrice, eggLvCost: eggLvCost,
      catchZone: catchZone, catchHit: catchHit, rollWild: rollWild, evolveOptions: evolveOptions,
      bossDef: bossDef, typeMult: typeMult, teamPower: teamPower, shardsFor: shardsFor,
      BOSS_WAIT_FROM: BOSS_WAIT_FROM, BOSS_STOCK_MAX: BOSS_STOCK_MAX, BOSS_REGEN_MS: BOSS_REGEN_MS,
      offlineGain: offlineGain, fmtBig: fmtBig, recipeKey: recipeKey
    };
    return;
  }

  // ============================================
  // ここからブラウザ用のゲーム本体
  // ============================================

  var SAVE_KEY = 'slime-farm-save';
  var S;            // 保存する状態（形は docs/PLAN_slime-farm.md 3.3）
  var cps = 0;      // 今の秒収入（牧場のマスにいる子だけ・ごきげんこみ）
  var cpsFull = 0;  // みんな元気なときの秒収入。留守の稼ぎはこちらで計算する（しょんぼりでも留守中は減らさない）
  var cpsBase = 0;  // 値段の基準。すみか・ごうせい台に入れた子も数える（入れて値段を下げる抜け道をふさぐ）
  var wildFx = {};  // のはらの野生の位置と跳ねる位相（保存しない）

  // 場面と操作の一時状態
  var scene = 'ranch';
  var ranchPage = 0;   // ぼくじょう２があるとき、見ているほう（0: ぼくじょう１・1: ぼくじょう２）
  var tkDest = 'mori', tkSeen = { t0: 0, n: 0 }, tkNotified = false;   // たんけん: 見ている行き先・浮かべた できごとの数・帰ってきた帯を出したか
  var fieldArea = 'grass';
  var catching = null;   // { area, idx, t0, zoneStart, zone }
  var drag = null;       // { from, pointerId, sx, sy, x, y, moved }
  var selected = -1;     // 2タップ選択中のマス（-1 = なし）
  var battle = null;     // とうばつ中の状態
  var pops = {};         // マス番号 → 進化・なでたときの弾みの開始時刻

  function now() { return Date.now(); }
  // 「きょうのおきゃくさん」は日本の日付で切り替える（端末のタイムゾーンに左右されないように）
  function jstDate(offsetDays) {
    return new Date(Date.now() + 9 * 3600 * 1000 + (offsetDays || 0) * 86400000).toISOString().slice(0, 10);
  }

  function newArea(lv) { return { lv: lv, wild: [], spawnAt: now() }; }

  function defaultState() {
    var cells = [];
    for (var i = 0; i < MIN_SIZE * MIN_SIZE; i++) cells.push('');
    cells[5] = slimeStr('green', false, -1, now());
    return {
      v: 1, coins: 30, lifetime: 0, size: MIN_SIZE, ranches: 1, cells: cells,
      food: {}, foodAt: {},
      eggLv: 1, eggBought: { grass: 0, water: 0, fire: 0 },
      areas: { grass: newArea(1), water: null, fire: null },
      nets: NET_BASE_MAX, netAt: now(), netLv: 1, netBought: 0,
      nest: { pairs: [] }, gousei: ['', ''], party: [],
      boss: { cleared: 0, wins: 0, battles: 0, streak: 0, stock: BOSS_STOCK_MAX, stockAt: now() }, fac: {},
      dex: { green: { first: jstDate(), shiny: false } }, recipes: [],
      shards: 0, prestige: 0, merges: 0, mutations: 0, shinyMet: 0, oyabunMet: 0,
      caught: 0, bought: 0, bred: 0,
      daily: { last: '', streak: 0 }, pref: {}, title: {},
      tanken: { trip: null, miss: {}, done: 0, found: 0, pending: '' },   // trip: 出ている たんけん・miss: 行き先ごとの連続はずれ・pending: 満員で待っている子
      startedAt: now(), lastTick: now()
    };
  }

  function num(v, d) { return typeof v === 'number' && isFinite(v) && v >= 0 ? v : d; }
  // お世話の時刻が入っていない＝お世話を入れる前の保存データ。読み込んだ時刻を「いまお世話した」ことにして、
  // 前から遊んでいる子が、開いたとたん やさぐれ にならないようにする
  function validStr(s) {
    var p = parseSlime(s);
    if (!p) return '';
    return p.care ? s : slimeStr(p.k, p.shiny, p.mark, now());
  }
  function validWild(s) { return typeof s === 'string' && parseSlime(s.charAt(0) === '*' ? s.slice(1) : s); }

  // 読み込みは欠けたキー・知らない種類があっても落ちないようにする
  function loadGame() {
    var d = defaultState(), raw = null;
    try { raw = JSON.parse(localStorage.getItem(SAVE_KEY) || 'null'); } catch (e) { raw = null; }
    if (!raw || typeof raw !== 'object') return { state: d, fresh: true };
    var s = d;
    s.coins = num(raw.coins, 0);
    s.lifetime = num(raw.lifetime, 0);
    s.size = Math.min(MAX_SIZE, Math.max(MIN_SIZE, Math.floor(num(raw.size, MIN_SIZE))));
    s.ranches = raw.ranches === 2 ? 2 : 1;
    s.cells = [];
    for (var i = 0; i < s.size * s.size * s.ranches; i++) s.cells.push(validStr(raw.cells && raw.cells[i]));
    s.eggLv = Math.min(3, Math.max(1, Math.floor(num(raw.eggLv, 1))));
    ['grass', 'water', 'fire'].forEach(function (l) { s.eggBought[l] = Math.floor(num(raw.eggBought && raw.eggBought[l], 0)); });
    AREA_ORDER.forEach(function (a) {
      var ra = raw.areas && raw.areas[a];
      if (!ra) { s.areas[a] = a === 'grass' ? newArea(1) : null; return; }
      s.areas[a] = {
        lv: Math.min(3, Math.max(1, Math.floor(num(ra.lv, 1)))),
        wild: (Array.isArray(ra.wild) ? ra.wild : []).filter(validWild).slice(0, WILD_MAX + 1),
        spawnAt: num(ra.spawnAt, now())
      };
    });
    s.nets = Math.floor(num(raw.nets, NET_BASE_MAX));
    s.netAt = num(raw.netAt, now());
    s.netLv = Math.min(NET_LV_MAX, Math.max(1, Math.floor(num(raw.netLv, 1))));
    s.netBought = Math.floor(num(raw.netBought, 0));
    FOODS.forEach(function (f) {
      s.food[f.id] = Math.min(FOOD_MAX, Math.floor(num(raw.food && raw.food[f.id], 0)));
      s.foodAt[f.id] = num(raw.foodAt && raw.foodAt[f.id], 0);
    });
    if (raw.fac && typeof raw.fac === 'object') {
      FACILITIES.forEach(function (f) {
        var lv = Math.floor(num(raw.fac[f.id], 0));
        if (lv > 0) s.fac[f.id] = Math.min(lv, f.secs.length);
      });
    }
    s.nest.pairs = (raw.nest && Array.isArray(raw.nest.pairs) ? raw.nest.pairs : []).slice(0, s.fac.nest || 0).map(function (p) {
      return { a: validStr(p && p.a), b: validStr(p && p.b), startAt: num(p && p.startAt, 0), egg: validStr(p && p.egg) };
    });
    s.gousei = [validStr(raw.gousei && raw.gousei[0]), validStr(raw.gousei && raw.gousei[1])];
    if (raw.boss) {
      s.boss.cleared = Math.min(BOSS_COUNT, Math.floor(num(raw.boss.cleared, 0)));
      s.boss.wins = Math.floor(num(raw.boss.wins, 0));
      s.boss.battles = Math.floor(num(raw.boss.battles, 0));
      s.boss.streak = Math.floor(num(raw.boss.streak, 0));
      // stock が無い古いセーブは まんたん から（31体目より先にいる子が、更新したとたんに待たされないように）
      s.boss.stock = Math.min(BOSS_STOCK_MAX, Math.floor(num(raw.boss.stock, BOSS_STOCK_MAX)));
      s.boss.stockAt = Math.min(now(), num(raw.boss.stockAt, now()));
    }
    // とうばつに出す子はマス番号で覚える。牧場で動かされていても pickParty が空きを強い順で埋める
    s.party = (Array.isArray(raw.party) ? raw.party : []).map(function (v) { return Math.floor(num(v, -1)); })
      .filter(function (v, i, arr) { return v >= 0 && v < s.cells.length && arr.indexOf(v) === i; }).slice(0, 3);
    if (raw.dex && typeof raw.dex === 'object') {
      Object.keys(raw.dex).forEach(function (k) {
        if (SPECIES[k] && raw.dex[k]) s.dex[k] = { first: String(raw.dex[k].first || jstDate()).slice(0, 10), shiny: !!raw.dex[k].shiny };
      });
    }
    s.recipes = (Array.isArray(raw.recipes) ? raw.recipes : []).filter(function (k) { return SPECIES[k] && SPECIES[k].recipe; });
    ['shards', 'prestige', 'merges', 'mutations', 'shinyMet', 'oyabunMet', 'caught', 'bought', 'bred'].forEach(function (k) {
      s[k] = Math.floor(num(raw[k], 0));
    });
    if (raw.daily) s.daily = { last: String(raw.daily.last || '').slice(0, 10), streak: Math.floor(num(raw.daily.streak, 0)) };
    if (raw.tanken && typeof raw.tanken === 'object') {
      var rt = raw.tanken.trip, rd = rt && typeof rt === 'object' ? tankenDest(rt.dest) : null;
      if (rd && rd.id === rt.dest) {
        s.tanken.trip = { dest: rd.id, t0: num(rt.t0, now()), power: num(rt.power, 0), members: [] };
        (Array.isArray(rt.members) ? rt.members : []).slice(0, 3).forEach(function (m) {
          if (m && SPECIES[m.k]) s.tanken.trip.members.push({ k: m.k, shiny: !!m.shiny });
        });
      }
      TANKEN_DESTS.forEach(function (d) { s.tanken.miss[d.id] = Math.floor(num(raw.tanken.miss && raw.tanken.miss[d.id], 0)); });
      s.tanken.done = Math.floor(num(raw.tanken.done, 0));
      s.tanken.found = Math.floor(num(raw.tanken.found, 0));
      s.tanken.pending = validStr(raw.tanken.pending);
    }
    if (raw.pref && typeof raw.pref === 'object') {
      Object.keys(raw.pref).forEach(function (k) { if (SPECIES[k] && SPECIES[raw.pref[k]]) s.pref[k] = raw.pref[k]; });
    }
    if (raw.title && typeof raw.title === 'object') s.title = { boss: !!raw.title.boss, dex: !!raw.title.dex };
    s.startedAt = num(raw.startedAt, now());
    s.lastTick = num(raw.lastTick, now());
    return { state: s, fresh: false };
  }

  function saveGame() {
    S.lastTick = now();
    try { localStorage.setItem(SAVE_KEY, JSON.stringify(S)); } catch (e) { /* 保存できなくても遊べればよい */ }
  }

  function recomputeCps() {
    cps = calcCps(S.cells, S.fac, S.shards, now());
    cpsFull = calcCps(S.cells, S.fac, S.shards);
    var off = S.gousei.slice();
    S.nest.pairs.forEach(function (p) { off.push(p.a, p.b); });
    cpsBase = cpsFull + calcCps(off, S.fac, S.shards);
  }

  function addCoins(v) {
    S.coins += v;
    S.lifetime += v;
  }

  function emptyCellIndex() {
    for (var i = 0; i < S.cells.length; i++) if (!S.cells[i]) return i;
    return -1;
  }
  function filledCount() {
    var n = 0;
    S.cells.forEach(function (c) { if (c) n++; });
    return n;
  }
  function addToRanch(str) {
    var i = emptyCellIndex();
    if (i >= 0) {
      S.cells[i] = str;
      pops[i] = performance.now();
    }
    return i;
  }

  // あと何秒でそれが買えるか。値段だけ見せると「永遠に無理」に見えて手が止まる
  function affordIn(cost) {
    if (S.coins >= cost) return tf('affordNow', '（{c} コイン・<b>いま買えるよ</b>）', { c: fmtBig(cost) });
    return tf('affordIn', '（{c} コイン・あと {t}）',
      { c: fmtBig(cost), t: cps > 0 ? fmtTime((cost - S.coins) / cps * 1000) : '？' });
  }

  // 満員のとき「いまできるマスのあけ方」を名指しする。
  // 重ねれば必ず進化するので同じ種類をまず探し、無ければ広げる・手放すを値段と待ち時間つきで出す
  function fullHint() {
    var cnt = {}, k;
    S.cells.forEach(function (c) { var s = parseSlime(c); if (s) cnt[s.k] = (cnt[s.k] || 0) + 1; });
    for (k in cnt) {
      if (cnt[k] >= 2 && evolveOptions(k).length) return tf('hintStack', '<b>{n}</b>が2匹いるよ。重ねて進化しよう', { n: SPECIES[k].name });
    }
    if (S.fac.gousei) {
      for (var i = 0; i < S.recipes.length; i++) {
        var r = SPECIES[S.recipes[i]].recipe;
        if (cnt[r[0]] && cnt[r[1]]) return tf('hintMix', 'ごうせい台で <b>{a}</b>＋<b>{b}</b> を合成しよう',
          { a: SPECIES[r[0]].name, b: SPECIES[r[1]].name });
      }
    }
    var tip = tx('hintFreeCell', 'スライムをタップして「<b>のはらにかえす</b>」か「<b>たびだたせる</b>」でマスをあけよう');
    if (S.size < MAX_SIZE) tip = tf('hintExpand', 'しせつタブの「<b>牧場をひろげる</b>」で {n}×{n} にできるよ', { n: S.size + 1 }) + affordIn(expandCost(S.size, cpsBase)) + '<br>' + tip;
    else if (S.ranches < 2) tip = tx('hintRanch2', 'しせつタブの「<b>ぼくじょう２をつくる</b>」でマスが2倍になるよ') + affordIn(ranch2Cost(cpsBase)) + '<br>' + tip;
    return tip;
  }

  function dexCount() { return Object.keys(S.dex).length; }
  function stageFound(stage) {
    return ORDER.some(function (k) { return S.dex[k] && SPECIES[k].stage === stage && !SPECIES[k].recipe && !SPECIES[k].mutation; });
  }

  // 図鑑に登録。初めての種類なら帯を出す
  function registerDex(k, shiny) {
    var d = S.dex[k];
    var isNew = !d;
    if (!d) d = S.dex[k] = { first: jstDate(), shiny: false };
    if (shiny) {
      S.shinyMet++;
      d.shiny = true;
    }
    if (isNew) {
      showBanner(tf('bannerNewSpecies', 'あたらしいスライム！ {n}', { n: SPECIES[k].name }), '#2E8B57');
      sfx('allclear');
      if (dexCount() >= ORDER.length) S.title.dex = true;
    }
    markDirty();
    return isNew;
  }

  // ---- のはら ----
  function newWildFx() {
    return { x: 0.12 + Math.random() * 0.76, y: 0.58 + Math.random() * 0.3, ph: Math.random() * 6.28 };
  }
  function fxFor(a) {
    var list = wildFx[a] || (wildFx[a] = []);
    var n = S.areas[a] ? S.areas[a].wild.length : 0;
    while (list.length < n) list.push(newWildFx());
    if (list.length > n) list.length = n;
    return list;
  }
  function addWild(a, str) {
    S.areas[a].wild.push(str);
    fxFor(a);
  }
  function removeWild(a, idx) {
    fxFor(a).splice(idx, 1);
    S.areas[a].wild.splice(idx, 1);
  }
  function startAreaLv() { return Math.min(3, 1 + Math.floor(S.shards / 5)); }

  // ボスを倒した数でのはらを開く
  function ensureAreas() {
    var opened = [];
    AREA_ORDER.forEach(function (a) {
      if (!S.areas[a] && S.boss.cleared >= AREAS[a].unlockBoss) {
        S.areas[a] = newArea(startAreaLv());
        for (var i = 0; i < 3; i++) addWild(a, rollWild(a, S.areas[a].lv));
        opened.push(a);
      }
    });
    return opened;
  }

  // 30秒に1匹・最大6匹。留守中のぶんも実時間でまとめて湧かせる
  function spawnWild(t) {
    var added = 0;
    AREA_ORDER.forEach(function (a) {
      var ar = S.areas[a];
      if (!ar) return;
      while (ar.wild.length < WILD_MAX && t - ar.spawnAt >= SPAWN_MS) {
        addWild(a, rollWild(a, ar.lv));
        ar.spawnAt += SPAWN_MS;
        added++;
      }
      if (ar.wild.length >= WILD_MAX) ar.spawnAt = t;
    });
    return added;
  }
  function wildTotal() {
    var n = 0;
    AREA_ORDER.forEach(function (a) { if (S.areas[a]) n += S.areas[a].wild.length; });
    return n;
  }

  function regenNets(t) {
    var max = netMax(S.fac.netHut), iv = netRegenMs(S.fac.netHut);
    while (S.nets < max && t - S.netAt >= iv) {
      S.nets++;
      S.netAt += iv;
    }
    if (S.nets >= max) S.netAt = t;
  }

  // ---- エサ ----
  // 枝分かれの施設が FOOD_SECS 秒に1つずつ作る（1施設 FOOD_MAX まで）。留守中のぶんもまとめて作る
  function growFood(t) {
    var got = 0;
    FOODS.forEach(function (f) {
      if (!S.fac[f.id]) return;
      if (!S.foodAt[f.id]) S.foodAt[f.id] = t;
      var n = S.food[f.id] || 0;
      while (n < FOOD_MAX && t - S.foodAt[f.id] >= FOOD_SECS * 1000) {
        n++;
        S.foodAt[f.id] += FOOD_SECS * 1000;
        got++;
      }
      if (n >= FOOD_MAX) S.foodAt[f.id] = t;
      S.food[f.id] = n;
    });
    return got;
  }
  // 段階ごとの数 [ごきげん, ふつう, しょんぼり, やさぐれ]（エサ カードの足元の案内に使う）
  function moodCounts() {
    var t = now(), n = [0, 0, 0, 0];
    S.cells.forEach(function (c) {
      var s = parseSlime(c);
      if (s) n[moodLevel(s.care, t)]++;
    });
    return n;
  }
  // しょんぼり以上の子の数（案内と「みんなにごはん」に使う）
  function sadCount() {
    var t = now(), n = 0;
    S.cells.forEach(function (c) {
      var s = parseSlime(c);
      if (s && moodLevel(s.care, t) >= 2) n++;
    });
    return n;
  }

  // ---- すみか ----
  function syncNestPairs() {
    var n = S.fac.nest || 0;
    while (S.nest.pairs.length < n) S.nest.pairs.push({ a: '', b: '', startAt: 0, egg: '' });
  }
  function breedChild(a, b) {
    var k = a.k === b.k ? a.k : (Math.random() < 0.5 ? a.k : b.k);
    var shinyParents = (a.shiny ? 1 : 0) + (b.shiny ? 1 : 0);
    return slimeStr(k, Math.random() < breedShinyRate(shinyParents, S.fac.spring));
  }
  // 親が2匹そろっていて時間がたった組にタマゴを置く（1組1個まで。留守中も進む）
  function progressNest(t) {
    var born = 0;
    S.nest.pairs.forEach(function (p) {
      var a = parseSlime(p.a), b = parseSlime(p.b);
      if (!a || !b || p.egg) return;
      if (!p.startAt) p.startAt = t;
      if (t - p.startAt >= breedMs(a.k, b.k)) {
        p.egg = breedChild(a, b);
        born++;
      }
    });
    if (born) markDirty();
    return born;
  }

  // ---- きょうのおきゃくさん・れんぞく日数 ----
  function checkDaily() {
    var today = jstDate();
    if (S.daily.last === today) return null;
    var cont = S.daily.last === jstDate(-1);
    var returning = !!S.daily.last;
    S.daily.streak = cont ? S.daily.streak + 1 : 1;
    S.daily.last = today;
    var open = AREA_ORDER.filter(function (a) { return S.areas[a]; });
    var a = open[Math.floor(Math.random() * open.length)];
    var ar = S.areas[a];
    var slot = areaPool(a)[Math.min(ar.lv + 1, 3) - 1], key = slot[Math.floor(Math.random() * slot.length)];
    if (ar.wild.length >= WILD_MAX) removeWild(a, 0);
    addWild(a, '*' + slimeStr(key, Math.random() < 0.1));
    return { streak: S.daily.streak, cont: cont, returning: returning, area: a, key: key };
  }

  // 留守のあいだの分: コイン（50%・上限8時間）・あみ・野生・タマゴ
  function applyOffline() {
    var t = now();
    var elapsed = Math.max(0, t - S.lastTick);
    // 留守の稼ぎは「みんな元気なとき」の秒収入で計算する。
    // 帰ってきたら しょんぼり でも留守中のコインは減らさない（減らすと平日10分の子が公開の基準を割る）
    var gain = offlineGain(elapsed, cpsFull);
    addCoins(gain);
    regenNets(t);
    regenBoss(t);
    var wild = spawnWild(t);
    var eggs = progressNest(t);
    growFood(t);
    return { elapsed: elapsed, coins: gain, wild: wild, eggs: eggs, sad: sadCount() };
  }

  // プレイ履歴に載せる進み具合（付録C。スカラーのみ）。
  // plays.php は extra の先頭20キーしか残さず、play-track.js がその日の最初のプレイに visit_days など3キーを後ろへ足す。
  // 25キー送っていたら daily・prestige と再訪の数値が切り捨てられていたので、17キー以内に保つ
  function reportProgress() {
    if (!window.PlayTrack) return;
    var top = 0;
    Object.keys(S.dex).forEach(function (k) { top = Math.max(top, SPECIES[k].stage); });
    var areas = AREA_ORDER.filter(function (a) { return S.areas[a]; }).length;
    window.PlayTrack.setExtra({
      top_stage: top, area: areas, caught: S.caught, bought: S.bought, bred: S.bred,
      lt_log10: S.lifetime > 1 ? Math.round(Math.log10(S.lifetime) * 100) / 100 : 0,
      merges: S.merges, dex: dexCount(), recipes: S.recipes.length, shiny: S.shinyMet, oyabun: S.oyabunMet,
      boss: S.boss.cleared, battles: S.boss.battles, wins: S.boss.wins,
      shards: S.shards, prestige: S.prestige, daily: S.daily.streak
    });
  }

  function sfx(name, opts) {
    if (window.GameAudio) window.GameAudio.sfx(name, opts);
  }

  // ============================================
  // 描画
  // ============================================

  var reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  // 素材は絶対パス（英語版 /games/en/games/slime-farm/ も同じ game.js を読むため）
  var SPRITE_DIR = '/games/games/slime-farm/sprites/';
  var SPRITE_VER = '20260911';
  var IMGS = {};
  function spriteUrl(k) { return SPRITE_DIR + k + '.png?v=' + SPRITE_VER; }
  ORDER.forEach(function (k) {
    var im = new Image();
    im.onload = function () { IMGS[k] = im; };
    im.src = spriteUrl(k);   // 404 のときは IMGS に入らず、canvas の仮スライムで描く
  });

  // しょんぼり・やさぐれの絵（54種×2＝108枚）。sprites に置いたら MOOD_SPRITE_VER に日付を入れると使われる。
  // 空のあいだは読みにいかず（404 を出さない）、ふつうの絵に色をかぶせて描く
  var MOOD_SPRITE_VER = '20260916';
  var MOOD_FILE = ['', '', 'sad', 'grumpy'];
  function moodImg(k, mood) {
    if (!MOOD_SPRITE_VER || mood < 2) return null;
    var key = k + '_' + MOOD_FILE[mood];
    if (IMGS[key] !== undefined) return IMGS[key];
    IMGS[key] = null;   // 読み込み中。毎フレーム読みにいかないように印をつける
    var im = new Image();
    im.onload = function () { IMGS[key] = im; };
    im.src = SPRITE_DIR + key + '.png?v=' + MOOD_SPRITE_VER;
    return null;
  }

  // 施設の絵（sprites/fac_<id>.png）。FAC_SPRITE に載せた施設だけ読みにいき、それ以外・読めるまでは絵文字で描く
  var FAC_SPRITE_VER = '20260917';
  var FAC_SPRITE = {};
  FACILITIES.forEach(function (f) { FAC_SPRITE[f.id] = true; });   // 14種ぜんぶ絵がある（sprites/fac_<id>.png）
  function facUrl(id) { return SPRITE_DIR + 'fac_' + id + '.png?v=' + FAC_SPRITE_VER; }
  function facImg(id) {
    if (!FAC_SPRITE[id]) return null;
    var key = 'fac_' + id;
    if (IMGS[key] !== undefined) return IMGS[key];
    IMGS[key] = null;
    var im = new Image();
    im.onload = function () { IMGS[key] = im; };
    im.src = facUrl(id);
    return null;
  }
  // HTML 側（しせつタブの行・カードの見出し）。読めなければ絵文字に戻す
  function facIconHtml(id, icon) {
    return FAC_SPRITE[id]
      ? '<img src="' + facUrl(id) + '" alt="" class="sf-fac-img" data-ic="' + icon + '" onerror="this.replaceWith(this.dataset.ic)">'
      : icon;
  }

  // 場面の背景（のはら sprites/bg_<area>.jpg・とうばつ sprites/bt_<area>.jpg）。読めるまでは元のグラデーション描画。
  // 場面を開いた瞬間に絵が切り替わらないよう、最初に6枚とも読んでおく（1枚 35〜50KB）
  var FIELD_BG_VER = '20260917';
  function sceneBg(key) {
    if (IMGS[key] !== undefined) return IMGS[key];
    IMGS[key] = null;
    var im = new Image();
    im.onload = function () { IMGS[key] = im; };
    im.src = SPRITE_DIR + key + '.jpg?v=' + FIELD_BG_VER;
    return null;
  }
  function fieldBgKey(a) { return sakuraField(a) ? 'sakura' : a; }
  function fieldBg(a) { return sceneBg('bg_' + fieldBgKey(a)); }
  // 縦横比が幅で変わる（0.6〜0.84）ので、4:3 の絵を中央基準の cover で敷く。切れるのは左右7%・上下6%まで
  function drawCover(im) {
    var sc = Math.max(W / im.width, H / im.height), bw = im.width * sc, bh = im.height * sc;
    ctx.drawImage(im, (W - bw) / 2, (H - bh) / 2, bw, bh);
    return { sc: sc, dx: (W - bw) / 2, dy: (H - bh) / 2 };   // 絵の座標（800×600）→ キャンバスの座標に使う
  }

  // 絵の上に足す動き。座標は 800×600 の絵の中の位置で持ち、cover の倍率と原点で変換する
  var SPARKLES = [];
  for (var spI = 0; spI < 18; spI++) {
    // 大きさ（2〜8）と またたきの速さを1つずつ変えて、同じ大きさの光が並ばないようにする
    SPARKLES.push({ x: 120 + ((spI * 137) % 560), y: 268 + ((spI * 53) % 70), ph: spI * 1.7, sz: 2 + ((spI * 5) % 7), sp: 0.0016 + (spI % 4) * 0.0006 });
  }
  // みずべ: 湖面（絵の y 262〜345）で星形の光が またたきながら ゆっくり流れる。光るにつれて 0.4→1.3倍に ふくらむ
  function drawWaterSparkle(m, t) {
    ctx.save();
    ctx.lineCap = 'round';
    SPARKLES.forEach(function (p) {
      var a = Math.max(0, Math.sin(t * p.sp + p.ph));
      if (a < 0.05) return;
      var x = m.dx + (p.x + Math.sin(t * 0.0004 + p.ph) * 8) * m.sc, y = m.dy + p.y * m.sc, r = p.sz * m.sc * (0.4 + a * 0.9);
      ctx.globalAlpha = a * 0.95;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = Math.max(1, (1 + p.sz * 0.15) * m.sc);
      ctx.beginPath();
      ctx.moveTo(x - r, y); ctx.lineTo(x + r, y);
      ctx.moveTo(x, y - r * 0.7); ctx.lineTo(x, y + r * 0.7);
      ctx.stroke();
    });
    ctx.restore();
  }
  // のはらの絵の中の雲を動かす（くさはら・みずべ）。絵を描き足さず、空にある雲を空の色との差で切り出して透明画像にし、
  // 雲の跡を空の色で埋めた絵（clean）を敷いて、その上を流す。雲は空の部分にだけ描く（木・たいよう・山・地平線の雲の手前に出ないよう、
  // 「空らしさ」をアルファにしたマスクで抜く）。端で切れている雲と木にかくれている雲は、見えている半分を鏡うつしにして
  // 1つの雲に仕立てる（mirror: 'l' は左が、'r' は右が切れている）。座標は 800×600 の絵のもの・v は1秒に進む px
  var SKY_ANIM = {
    grass: {
      h: 215, col: 300,            // 空の色は雲のない列 x=300 から取る（この絵の空は横方向に一様）
      sun: [684, 86, 72],          // たいようの光のにじみは雲ではないので、この円の中は切り出さない
      clouds: [
        { x: 0,   y: 48,  w: 96,  h: 70, v: 6, mirror: 'l' },
        { x: 412, y: 24,  w: 160, h: 64, v: 5 },
        { x: 149, y: 109, w: 122, h: 52, v: 8 },
        { x: 371, y: 158, w: 58,  h: 48, v: 9, mirror: 'r', ew: 76 },   // 木のうしろの雲。x 429 で折り返し、木ぎわ（ew）まで消す
        { x: 722, y: 110, w: 78,  h: 70, v: 7, mirror: 'r' }
      ]
    },
    water: {
      h: 215, col: 390, local: true,   // 端の空がうすくかすんでいて一様でないので、空の色は雲の左右のふちを行ごとに補間する（col はマスク用）
      clouds: [
        { x: 15,  y: 25,  w: 232, h: 104, v: 5 },
        { x: 414, y: 20,  w: 190, h: 80,  v: 6 },
        { x: 224, y: 116, w: 130, h: 50,  v: 8 },
        { x: 429, y: 165, w: 86,  h: 36,  v: 10 },
        { x: 728, y: 19,  w: 72,  h: 57,  v: 7, mirror: 'r' }
      ]
    },
    // かざん（9/17 夜「火山の雲もイラストごと動かせたら動かして」）: 空は夕やけの橙で かざんの上ほど明るく、横にも色が変わるので
    // 「列との差」では空を見分けられない。雲は cream・空は橙・けむり は灰色なので、warm（r−b が小さい＝灰色）だけを空でない扱いにして、
    // 雲は けむり のうしろを通す。左上の雲は左端で切れ、右上の小さい雲と大きい雲は重なっているので1つにまとめて右端で折り返す。
    // 下のほう（y 130〜）の雲は山や雲の土手にかかるので動かさない
    fire: {
      h: 130, col: 340, local: true, warm: true,
      clouds: [
        { x: 0,   y: 23, w: 223, h: 96,  v: 5, mirror: 'l' },
        { x: 512, y: 21, w: 288, h: 100, v: 6, mirror: 'r' }
      ]
    }
  };
  var skyAnim = {};   // area → { clean, mask, layer, clouds, w, h } ／ false = 作れなかった（画素が取れないとき）→ 絵をそのまま敷く
  function buildSky(cfg, im) {
    try {
      var iw = im.width, ih = im.height, H = cfg.h;
      var src = document.createElement('canvas'), sx = src.getContext('2d');
      src.width = iw; src.height = ih; sx.drawImage(im, 0, 0);
      var d = sx.getImageData(0, 0, iw, H).data;   // 別オリジンだとここで例外
      var clean = document.createElement('canvas'), kx = clean.getContext('2d');
      clean.width = iw; clean.height = ih; kx.drawImage(im, 0, 0);
      var cb = kx.getImageData(0, 0, iw, H), cd = cb.data;
      function px(x, y) { var o = (y * iw + x) * 4; return [d[o], d[o + 1], d[o + 2]]; }
      var clouds = cfg.clouds.map(function (r) {
        var x0 = r.x, x1 = Math.min(iw, x0 + (r.ew || r.w)), sw = r.mirror ? r.w * 2 : r.w;
        var c = document.createElement('canvas'), cx = c.getContext('2d');
        c.width = sw; c.height = r.h;
        var sp = cx.createImageData(r.w, r.h);
        for (var y = r.y; y < r.y + r.h; y++) {
          var L, R;
          if (!cfg.local) { L = R = px(cfg.col, y); }
          else {
            L = r.mirror === 'l' ? null : px(Math.max(0, x0 - 2), y);
            R = r.mirror === 'r' ? null : px(Math.min(iw - 1, x1 + 1), y);
            if (!L) L = R;
            if (!R) R = L;
          }
          for (var x = x0; x < x1; x++) {
            var f = (x - x0) / Math.max(1, x1 - 1 - x0), o = (y * iw + x) * 4, diff = 0, k = [0, 0, 0];
            for (var i = 0; i < 3; i++) { k[i] = L[i] + (R[i] - L[i]) * f; diff = Math.max(diff, Math.abs(d[o + i] - k[i])); }
            var a = Math.min(1, Math.max(0, (diff - (cfg.warm ? 12 : 10)) / (cfg.warm ? 24 : 36)));
            // 緑（木）や黄色（たいよう）は雲ではない。白に近い画素は JPEG の色むらで黄ばんでいても雲（warm の雲は cream で ふちが茶色なのでこの除外はしない）
            if (!cfg.warm && Math.min(d[o], d[o + 1], d[o + 2]) < 215 && (d[o + 2] < d[o + 1] - 12 || d[o + 2] < d[o] - 12)) a = 0;
            if (cfg.sun && Math.sqrt((x - cfg.sun[0]) * (x - cfg.sun[0]) + (y - cfg.sun[1]) * (y - cfg.sun[1])) < cfg.sun[2]) a = 0;
            if (a > 0) { cd[o] = Math.round(k[0]); cd[o + 1] = Math.round(k[1]); cd[o + 2] = Math.round(k[2]); }
            if (x < x0 + r.w) {
              var q = ((y - r.y) * r.w + x - x0) * 4;
              sp.data[q] = d[o]; sp.data[q + 1] = d[o + 1]; sp.data[q + 2] = d[o + 2]; sp.data[q + 3] = Math.round(255 * a);
            }
          }
        }
        cx.putImageData(sp, r.mirror === 'l' ? r.w : 0, 0);
        if (r.mirror) {   // 見えている半分を左右反転して、切れている側に足す
          cx.save(); cx.scale(-1, 1);
          cx.drawImage(c, r.mirror === 'l' ? r.w : 0, 0, r.w, r.h, r.mirror === 'l' ? -r.w : -sw, 0, r.w, r.h);
          cx.restore();
        }
        return { cv: c, x: r.mirror === 'l' ? r.x - r.w : r.x, y: r.y, w: sw, v: r.v };
      });
      kx.putImageData(cb, 0, 0);
      // 空らしさ: 雲を消した絵と空の色の差が 30 までは空、44 以上は空でない（木・たいよう・山・地平線の雲）。かすみ や たいようの光のにじみは空あつかい
      var mask = document.createElement('canvas'), mx = mask.getContext('2d');
      mask.width = iw; mask.height = H;
      var md = mx.createImageData(iw, H);
      for (var j = 0; j < iw * H; j++) {
        var o2 = j * 4, ko = (Math.floor(j / iw) * iw + cfg.col) * 4, al;
        if (cfg.warm) al = Math.min(1, Math.max(0, (cd[o2] - cd[o2 + 2] - 32) / 20));   // 灰色（r−b が 32 以下）は けむり
        else {
          var df = Math.max(Math.abs(cd[o2] - cd[ko]), Math.abs(cd[o2 + 1] - cd[ko + 1]), Math.abs(cd[o2 + 2] - cd[ko + 2]));
          al = 1 - Math.min(1, Math.max(0, (df - 30) / 14));
        }
        md.data[o2] = 255; md.data[o2 + 1] = 255; md.data[o2 + 2] = 255;
        md.data[o2 + 3] = Math.round(255 * al);
      }
      mx.putImageData(md, 0, 0);
      var layer = document.createElement('canvas');
      layer.width = iw; layer.height = H;
      return { clean: clean, mask: mask, layer: layer, clouds: clouds, w: iw, h: H };
    } catch (e) {
      return false;
    }
  }
  function drawSkyClouds(g, t) {
    var lx = g.layer.getContext('2d');
    lx.clearRect(0, 0, g.w, g.h);
    g.clouds.forEach(function (c, i) {
      // 右へ流れ、右端を出きったら左から戻る（1周は 絵の幅＋雲の幅）
      var span = g.w + c.w, x = (((c.x + c.w + t * c.v / 1000) % span) + span) % span - c.w;
      lx.drawImage(c.cv, x, c.y + Math.sin(t * 0.0003 + i) * 2);
    });
    lx.globalCompositeOperation = 'destination-in';
    lx.drawImage(g.mask, 0, 0);
    lx.globalCompositeOperation = 'source-over';
    var m = drawCover(g.clean);
    ctx.drawImage(g.layer, m.dx, m.dy, g.w * m.sc, g.h * m.sc);
    return m;
  }
  AREA_ORDER.forEach(function (a) { fieldBg(a); });   // とうばつの舞台は bossBgKey のぶんだけ、初期化と drawBattle で読む
  // てんくう: 絵の中の たいよう を光の線と きらめき ごと切り出して、その場でくるくる回す（9/17 夜「天空の背景の太陽がクルクル回るようにして」）。
  // 雲と同じく「空の色との差」をアルファにして、中心から r の円の中だけ抜く。跡は行ごとに円のふちの色で埋めた絵（clean）を敷き、その上で回す。
  // 円の中は空と たいよう だけにしておく（雲や島がかかると一緒に回る）。同じ絵で SKY_ANIM の雲も動かすことは想定していない（clean が2枚になる）。
  // 座標は 800×600 の絵のもの・rev は1回転にかかる ms。光のにじみは中心対称なので、回っても線と きらめき だけが動いて見える
  var SUN_SPIN = { sky: { cx: 592, cy: 127, r: 112, rev: 12000 } };
  var sunAnim = {};   // 絵のキー → { clean, sprite, x0, y0, cfg } ／ false = 作れなかった（画素が取れないとき）→ 絵をそのまま敷く
  function buildSun(cfg, im) {
    try {
      var iw = im.width, ih = im.height, R = cfg.r, cx = cfg.cx, cy = cfg.cy;
      var clean = document.createElement('canvas'), kx = clean.getContext('2d');
      clean.width = iw; clean.height = ih; kx.drawImage(im, 0, 0);
      // 箱は円より左右3px広く取り、その3px外の色を行ごとの「空の色」にする
      var x0 = Math.max(0, cx - R - 3), y0 = Math.max(0, cy - R), bw = Math.min(iw, cx + R + 4) - x0, bh = Math.min(ih, cy + R + 1) - y0;
      var box = kx.getImageData(x0, y0, bw, bh), d = box.data;   // 別オリジンだとここで例外
      var sp = kx.createImageData(bw, bh);
      for (var y = 0; y < bh; y++) {
        var dy = y + y0 - cy, hw = Math.sqrt(Math.max(0, R * R - dy * dy));
        var xl = Math.max(0, Math.floor(cx - hw) - x0), xr = Math.min(bw - 1, Math.ceil(cx + hw) - x0);
        var oL = (y * bw + Math.max(0, xl - 3)) * 4, oR = (y * bw + Math.min(bw - 1, xr + 3)) * 4;
        for (var x = xl; x <= xr; x++) {
          var f = (x - xl) / Math.max(1, xr - xl), o = (y * bw + x) * 4, diff = 0, k = [0, 0, 0];
          for (var i = 0; i < 3; i++) { k[i] = d[oL + i] + (d[oR + i] - d[oL + i]) * f; diff = Math.max(diff, Math.abs(d[o + i] - k[i])); }
          var a = Math.min(1, Math.max(0, (diff - 10) / 36));
          sp.data[o] = d[o]; sp.data[o + 1] = d[o + 1]; sp.data[o + 2] = d[o + 2]; sp.data[o + 3] = Math.round(255 * a);
          d[o] = Math.round(k[0]); d[o + 1] = Math.round(k[1]); d[o + 2] = Math.round(k[2]);
        }
      }
      kx.putImageData(box, x0, y0);
      var sprite = document.createElement('canvas');
      sprite.width = bw; sprite.height = bh; sprite.getContext('2d').putImageData(sp, 0, 0);
      return { clean: clean, sprite: sprite, x0: x0, y0: y0, cfg: cfg };
    } catch (e) {
      return false;
    }
  }
  function drawSun(g, m, t) {
    var c = g.cfg;
    ctx.save();
    ctx.translate(m.dx + c.cx * m.sc, m.dy + c.cy * m.sc);
    ctx.rotate((t % c.rev) / c.rev * Math.PI * 2);
    ctx.drawImage(g.sprite, (g.x0 - c.cx) * m.sc, (g.y0 - c.cy) * m.sc, g.sprite.width * m.sc, g.sprite.height * m.sc);
    ctx.restore();
  }
  // さくらの くさはら: 花びらを降らせる。位置は番号と t だけから決める（配列も保存も持たず、タブを離れても続きから流れる）
  // うちゅう: 空（絵の上側）に星を40個またたかせる。位置は番号から決め、絵（800×600）の座標を drawCover の倍率で変換する
  var SPACE_STARS = [];
  for (var si = 0; si < 40; si++) {
    // スマホ幅では絵が約0.57倍に縮むので、半径は 1.4〜3.0（縮めて 0.8〜1.7px）にしないと またたきが見えない
    SPACE_STARS.push({ x: si * 7919 % 800, y: 12 + si * 104729 % 150, r: 1.4 + (si * 31 % 3) * 0.8, ph: si * 0.7, sp: 1.5 + (si % 4) * 0.6 });
  }
  function drawSpaceStars(m, t) {
    ctx.save();
    ctx.fillStyle = '#ffffff';
    SPACE_STARS.forEach(function (s) {
      ctx.globalAlpha = 0.2 + 0.8 * Math.abs(Math.sin(t / 1000 * s.sp + s.ph));
      ctx.beginPath();
      ctx.arc(m.dx + s.x * m.sc, m.dy + s.y * m.sc, s.r * m.sc, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.restore();
  }
  var PETAL_N = 28;
  function drawPetals(t) {
    ctx.save();
    ctx.globalAlpha = 0.85;
    for (var i = 0; i < PETAL_N; i++) {
      var s = (i * 7919 % 1000) / 1000, s2 = (i * 104729 % 1000) / 1000;
      var p = ((t / 1000) / (9 + 6 * s2) + s) % 1;                 // 0→1 で上から下へ（1枚 9〜15秒）
      var x = (((s2 * W + Math.sin(t / 1000 * (0.6 + s) + i) * 16 + p * 80 * (s - 0.3)) % W) + W) % W;
      var y = -8 + p * (H + 16), r = 2.5 + 2 * s;
      ctx.fillStyle = i % 3 ? '#ffc2d6' : '#ffe4ee';
      ctx.beginPath();
      ctx.ellipse(x, y, r, r * 0.6, t / 1000 * (1 + s) + i, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  // 画像が読めないときの仮スライムの色（淡い・本体・影・輪郭）
  var LINE_COL = {
    grass: ['#c4f5a4', '#7ed957', '#3f9a2a', '#2d7c18'],
    water: ['#c9ecff', '#5ab7f0', '#2a7cc0', '#1f5f99'],
    fire: ['#ffd3b8', '#ff7d4d', '#d6412a', '#9c2a15'],
    none: ['#f6f6f6', '#dcdcdc', '#9a9a9a', '#6f6f6f']
  };
  var SP_COL = {
    sea: ['#a9dcff', '#2f9fd8', '#1b6aa8', '#134f80'], ice: ['#ffffff', '#cfefff', '#7fc4ea', '#4f93b8'],
    magma: ['#a3705a', '#6b4030', '#3e2218', '#2a150e'], sun: ['#fff1b0', '#ffb347', '#e07d1a', '#a85a0c'],
    thunder: ['#ffffc8', '#fff176', '#e0c22c', '#a08a12'], ajisai: ['#e4e8ff', '#9db7f2', '#5c78c9', '#3f549a'],
    yakiimo: ['#d9a8ea', '#8e5bb5', '#5b3480', '#3f2159'], onsen: ['#eafcfc', '#a8d8d8', '#5fa8a8', '#3f7d7d'],
    pearl: ['#ffffff', '#f2e6f7', '#c9a9d9', '#9a7cae'], yuki: ['#ffffff', '#eaf6ff', '#a9cbe6', '#7aa1c0'],
    star: ['#fff9c4', '#ffe066', '#e0b400', '#a88500'], oyabun: LINE_COL.grass,
    sakura: ['#fff0f6', '#ffb7d5', '#e8739f', '#b5486f'], cloud: ['#ffffff', '#f4f9ff', '#bcd8f5', '#7fa6cc'],
    hotaru: ['#fff6c8', '#ffd25a', '#c9961c', '#2b3a66'], sango: ['#ffe4dc', '#ff9a7a', '#e0603f', '#a33d26'],
    dragon: ['#ffd0c8', '#e83a3a', '#a81c1c', '#5e0e0e'], fairy: ['#fbf1ff', '#e6c3f5', '#b27fd6', '#7b4f9e'],
    kaze: ['#ffffff', '#e8f4ff', '#a9cdef', '#6f98c4'], tsuki: ['#fffbe6', '#ffe9a3', '#e0b94a', '#2a3566'], tenshi: ['#ffffff', '#fff7dd', '#f0d27a', '#b8933a'],
    himawari: ['#fff7c2', '#ffd93b', '#e0a800', '#6b4a1a'], kabocha: ['#ffe0b3', '#ff9f3a', '#d8721a', '#3f7a2a'],
    aurora: ['#e8fff8', '#8ff0d0', '#4fb8c9', '#3b4f9a'], arashi: ['#e6ecf5', '#9fb2c9', '#5c6f8c', '#3b4658'],
    houseki: ['#ffe6f5', '#ff8ad0', '#c94fa8', '#6e2a6a'], ginga: ['#e6e0ff', '#8f7cff', '#4c3bb8', '#1f1a5e'],
    inseki: ['#e8dcd0', '#b49a86', '#7d6250', '#3d2e24'], suisei: ['#eef6ff', '#a8d4ff', '#5c9fe0', '#2b4f8a'],
    dosei: ['#fff3d6', '#f5c877', '#d9964a', '#7a4f1e'], blackhole: ['#e0d6ff', '#7a5cff', '#3a1f8f', '#120a3a'],
    alien: ['#f0e6ff', '#c9a8ff', '#9a6fe0', '#4a2f80'], kamisama: ['#fffdf0', '#ffe9a3', '#e0b23a', '#8a6a1a'],
    obake: ['#f6f2ff', '#d9ccf2', '#a48fd0', '#5a4a80'], golem: ['#e6e2dc', '#a8a09a', '#6e6660', '#3a3430'], mimic: ['#f1e0ff', '#a86ee0', '#6a3ab0', '#2e1660']
  };
  function colOf(k) { return SP_COL[k] || LINE_COL[SPECIES[k].line]; }

  // きらきら・シルエットは同じ画像をオフスクリーンで塗り重ねて作る（ctx.filter は Safari が新しいので使わない）
  var variantCache = {};
  function spriteVariant(k, kind) {
    var ck = k + ':' + kind;
    if (variantCache[ck]) return variantCache[ck];
    var im = IMGS[k], c = document.createElement('canvas');
    c.width = im.width;
    c.height = im.height;
    var x = c.getContext('2d');
    x.drawImage(im, 0, 0);
    x.globalCompositeOperation = 'source-atop';
    if (kind === 'sil') {
      x.fillStyle = '#3a3a3a';
    } else if (kind === 'sad') {
      x.fillStyle = 'rgba(96,116,148,.40)';    // しょんぼり: 青くくすませる
    } else if (kind === 'grumpy') {
      x.fillStyle = 'rgba(58,58,72,.55)';      // やさぐれ: さらに暗く
    } else {
      var g = x.createLinearGradient(0, c.height, c.width, 0);
      g.addColorStop(0, 'rgba(255,120,200,.42)');
      g.addColorStop(0.5, 'rgba(255,255,150,.32)');
      g.addColorStop(1, 'rgba(120,200,255,.42)');
      x.fillStyle = g;
    }
    x.fillRect(0, 0, c.width, c.height);
    variantCache[ck] = c;
    return c;
  }

  function star5(c, x, y, r) {
    c.beginPath();
    for (var i = 0; i < 10; i++) {
      var a = -Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? r * 0.45 : r;
      c.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
    }
    c.closePath();
  }

  function drawSparkles(c, x, foot, r, t) {
    c.save();
    c.fillStyle = '#fff8c0';
    c.strokeStyle = '#e8b400';
    c.lineWidth = 1;
    [[-1.1, -2.1], [1.15, -1.7], [0.9, -0.5]].forEach(function (p, i) {
      var tw = reduced ? 1 : 0.7 + 0.3 * Math.sin(t * 0.01 + i * 2);
      star5(c, x + p[0] * r, foot + p[1] * r, r * 0.17 * tw);
      c.fill();
      c.stroke();
    });
    c.restore();
  }

  // スライム1匹。foot = 足元の y。o: { t, seed, shiny, sil, boss, squash, scale, hurt }
  function drawSlime(c, x, foot, r, k, o) {
    o = o || {};
    var t = o.t || 0;
    if (o.scale) r *= o.scale;
    var sq = o.squash != null ? o.squash : (reduced ? 0 : Math.sin(t * 0.006 + (o.seed || 0) * 2) * 0.05);
    c.save();
    c.translate(x, foot);
    if (o.boss) {
      c.shadowColor = 'rgba(214,65,42,.9)';
      c.shadowBlur = r * 0.9;
    }
    c.scale(1 + sq, 1 - sq);
    if (o.hurt) c.globalAlpha *= 0.75;
    var mood = o.mood || 0;
    if (IMGS[k]) {
      var im = moodImg(k, mood) ||
        (o.sil ? spriteVariant(k, 'sil') : mood >= 2 ? spriteVariant(k, MOOD_FILE[mood]) : o.shiny ? spriteVariant(k, 'shiny') : IMGS[k]);
      var ih = r * 2.4, iw = ih * im.width / im.height;
      if (iw > r * 2.7) { iw = r * 2.7; ih = iw * im.height / im.width; }
      c.drawImage(im, -iw / 2, -ih, iw, ih);
    } else {
      if (mood >= 2) c.globalAlpha *= mood >= 3 ? 0.55 : 0.72;   // 仮スライムは薄くして しょんぼり を見せる
      drawFallbackBody(c, r, k, o);
    }
    c.restore();
    if (o.shiny && !o.sil) drawSparkles(c, x, foot, r, t);
  }

  function drawFallbackBody(c, r, k, o) {
    var col = colOf(k);
    c.beginPath();
    c.moveTo(-r, 0);
    c.bezierCurveTo(-r * 1.15, -r * 0.9, -r * 0.75, -r * 1.85, 0, -r * 1.85);
    c.bezierCurveTo(r * 0.75, -r * 1.85, r * 1.15, -r * 0.9, r, 0);
    c.closePath();
    if (k === 'rainbow') {
      var lg = c.createLinearGradient(-r, -r * 1.8, r, 0);
      ['#ff6b6b', '#ffd166', '#8ce99a', '#74c0fc', '#b197fc'].forEach(function (h, i) { lg.addColorStop(i / 4, h); });
      c.fillStyle = lg;
    } else {
      var g = c.createRadialGradient(-r * 0.3, -r * 1.25, r * 0.05, 0, -r * 0.9, r * 1.35);
      g.addColorStop(0, col[0]);
      g.addColorStop(0.55, col[1]);
      g.addColorStop(1, col[2]);
      c.fillStyle = g;
    }
    c.fill();
    c.shadowBlur = 0;
    if (o.sil) {
      c.fillStyle = '#3a3a3a';
      c.fill();
      return;
    }
    c.lineWidth = Math.max(1.5, r * 0.09);
    c.strokeStyle = col[3];
    c.stroke();
    if (o.shiny) {
      var rg = c.createLinearGradient(-r, 0, r, -r * 1.8);
      rg.addColorStop(0, 'rgba(255,120,200,.35)');
      rg.addColorStop(1, 'rgba(120,200,255,.35)');
      c.fillStyle = rg;
      c.fill();
    }
    c.fillStyle = 'rgba(255,255,255,.45)';
    c.beginPath();
    c.ellipse(-r * 0.38, -r * 1.35, r * 0.22, r * 0.14, -0.5, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = '#2b2b2b';
    [-1, 1].forEach(function (d) {
      c.beginPath();
      c.arc(d * r * 0.3, -r * 0.85, r * 0.12, 0, Math.PI * 2);
      c.fill();
    });
    c.lineWidth = r * 0.07;
    c.strokeStyle = '#2b2b2b';
    c.beginPath();
    c.arc(0, -r * 0.58, r * 0.13, 0.3, Math.PI - 0.3);
    c.stroke();
    if (k === 'oyabun') {
      c.fillStyle = '#ffd166';
      c.beginPath();
      c.moveTo(-r * 0.6, -r * 1.75); c.lineTo(-r * 0.6, -r * 2.35); c.lineTo(-r * 0.25, -r * 2.0); c.lineTo(0, -r * 2.5);
      c.lineTo(r * 0.25, -r * 2.0); c.lineTo(r * 0.6, -r * 2.35); c.lineTo(r * 0.6, -r * 1.75);
      c.closePath();
      c.fill();
      c.stroke();
    }
  }

  // ---- canvas ----
  var cv = document.getElementById('sf-canvas');
  var ctx = cv.getContext('2d');
  var W = 400, H = 330;
  var DPR = Math.min(2, window.devicePixelRatio || 1);
  var FONT = '"Hiragino Maru Gothic ProN", "Hiragino Sans", "Noto Sans JP", "Yu Gothic", Meiryo, sans-serif';

  function resizeCanvas() {
    var w = Math.round(cv.getBoundingClientRect().width || 400);
    var h = Math.round(Math.max(290, Math.min(420, w * (w > 480 ? 0.76 : 0.84))));
    if (w === W && h === H && cv.width === Math.round(w * DPR)) return;
    W = w;
    H = h;
    cv.width = Math.round(W * DPR);
    cv.height = Math.round(H * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  }

  // 牧場のマスは正方形のまま中央に置く（PC幅で余る左右には施設が建つ）。
  // ぼくじょう２があるときは S.cells の後半がそれで、base から n×n 個だけを描く（マスの番号は通しのまま）
  function ranchLayout() {
    var n = S.size, pad = 34;
    if (ranchPage >= S.ranches) ranchPage = 0;
    var cell = Math.floor(Math.min((W - pad * 2) / n, (H - pad * 2) / n));
    return { n: n, cell: cell, ox: Math.round((W - cell * n) / 2), oy: Math.round((H - cell * n) / 2), base: ranchPage * n * n };
  }
  function cellRect(L, i) { var j = i - L.base; return { x: L.ox + (j % L.n) * L.cell, y: L.oy + Math.floor(j / L.n) * L.cell }; }
  function slimeR(L, k) { return L.cell * 0.25 * (0.85 + SPECIES[k].stage * 0.05) * (k === 'oyabun' ? 1.15 : 1); }

  // のはらの野生の位置（描画と当たり判定で同じ式を使う）
  function wildPos(a, i, t) {
    var fx = fxFor(a)[i], s = parseSlime(S.areas[a].wild[i].replace('*', ''));
    var r = Math.min(W, H) * 0.052 + s.k.length * 0 + SPECIES[s.k].stage * 2.5;
    var frozen = catching && catching.area === a && catching.idx === i;
    var hop = reduced || frozen ? 0 : Math.max(0, Math.sin(t * 0.004 + fx.ph)) * 16;
    var drift = reduced || frozen ? 0 : Math.sin(t * 0.00025 + fx.ph * 3) * 0.05;
    return { x: (fx.x + drift) * W, foot: fx.y * H, hop: hop, r: r, s: s, visitor: S.areas[a].wild[i].charAt(0) === '*' };
  }

  // ---- 演出（浮き文字・粒・帯） ----
  var floats = [], particles = [], banner = null, bubble = null;
  function addFloat(x, y, text, color) {
    floats.push({ x: x, y: y, text: text, color: color || '#B3560A', t0: performance.now() });
    if (floats.length > 30) floats.shift();
  }
  function burst(x, y, color, n) {
    var t0 = performance.now();
    for (var i = 0; i < (n || 8); i++) {
      var a = Math.random() * Math.PI * 2, sp = 40 + Math.random() * 80;
      particles.push({ x: x, y: y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 40, color: color || '#ffd166', t0: t0, life: 600 + Math.random() * 400 });
    }
    if (particles.length > 240) particles.splice(0, particles.length - 240);
  }
  function showBanner(text, color) { banner = { text: text, color: color || '#B3560A', t0: performance.now() }; }
  // のはらのスライム本人に言わせる。画面下のヒント欄より、触った子の頭の上のほうが子どもは気づく
  function sayWild(area, idx, text) { bubble = { area: area, idx: idx, text: text, t0: performance.now() }; }

  function drawFx(t) {
    var i;
    for (i = particles.length - 1; i >= 0; i--) {
      var p = particles[i], age = (t - p.t0) / 1000;
      if (age * 1000 > p.life) { particles.splice(i, 1); continue; }
      ctx.globalAlpha = Math.max(0, 1 - age * 1000 / p.life);
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x + p.vx * age - 3, p.y + p.vy * age + 160 * age * age - 3, 6, 6);
    }
    ctx.globalAlpha = 1;
    ctx.textAlign = 'center';
    ctx.font = '900 14px ' + FONT;
    for (i = floats.length - 1; i >= 0; i--) {
      var f = floats[i], fa = (t - f.t0) / 1000;
      if (fa > 1.1) { floats.splice(i, 1); continue; }
      ctx.globalAlpha = Math.min(1, 2.2 - fa * 2);
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(255,255,255,.9)';
      ctx.strokeText(f.text, f.x, f.y - fa * 30);
      ctx.fillStyle = f.color;
      ctx.fillText(f.text, f.x, f.y - fa * 30);
    }
    ctx.globalAlpha = 1;
    if (banner) {
      var ba = (t - banner.t0) / 1000;
      if (ba > 2) {
        banner = null;
      } else {
        var slide = reduced ? 0 : Math.max(0, 0.18 - ba) * 400;
        ctx.save();
        ctx.globalAlpha = Math.min(1, (2 - ba) * 3);
        ctx.translate(W / 2 - slide, H * 0.36);
        ctx.rotate(-0.04);
        ctx.fillStyle = 'rgba(255,255,255,.94)';
        ctx.fillRect(-W / 2 - 10, -22, W + 20, 40);
        ctx.fillStyle = banner.color;
        ctx.font = '900 ' + (W < 380 ? 17 : 20) + 'px ' + FONT;
        ctx.fillText(banner.text, 0, 6);
        ctx.restore();
      }
    }
    ctx.textAlign = 'left';
  }

  // ---- 場面: ぼくじょう ----
  function drawRanch(t) {
    var g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#c9ec9f');
    g.addColorStop(1, '#a6d96a');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(255,255,255,.16)';
    for (var i = 0; i < 16; i++) {
      ctx.beginPath();
      ctx.ellipse((i * 97) % W, (i * 61) % H, 24, 8, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    // 柵
    ctx.fillStyle = '#c99a5b';
    ctx.strokeStyle = '#7a5530';
    ctx.lineWidth = 1.2;
    for (var f = 0; f <= 10; f++) {
      var fx = 8 + f * (W - 16) / 10;
      ctx.fillRect(fx - 3, 6, 6, 16);
      ctx.strokeRect(fx - 3, 6, 6, 16);
      ctx.fillRect(fx - 3, H - 22, 6, 16);
      ctx.strokeRect(fx - 3, H - 22, 6, 16);
    }
    ctx.fillRect(8, 11, W - 16, 4);
    ctx.fillRect(8, H - 17, W - 16, 4);

    var L = ranchLayout();
    // 買った施設を牧場の左右に建てる
    var owned = FACILITIES.filter(function (fc) { return S.fac[fc.id]; });
    var rowH = (H - 80) / 7, facSz = Math.min(L.ox - 10, rowH - 2, 52);
    ctx.font = Math.min(22, Math.max(14, L.ox - 10)) + 'px ' + FONT;
    ctx.textAlign = 'center';
    owned.forEach(function (fc, k) {
      var side = k % 2, row = Math.floor(k / 2);
      var x = side ? W - L.ox / 2 : L.ox / 2, y = 50 + row * rowH;
      var im = facImg(fc.id);
      if (im) {
        // 絵も絵文字と同じ枠（縁の幅・行の高さ）に収める。絵文字の字面は y の上 20px ほどなので中心を合わせる
        var s = facSz / Math.max(im.width, im.height), iw = im.width * s, ih = im.height * s;
        ctx.drawImage(im, x - iw / 2, y - 8 - ih / 2, iw, ih);
      } else ctx.fillText(fc.icon, x, y);
    });
    ctx.textAlign = 'left';

    var src = drag && drag.moved ? drag.from : selected;
    var srcS = src >= 0 ? parseSlime(S.cells[src]) : null;
    for (i = L.base; i < L.base + L.n * L.n; i++) {
      var rc = cellRect(L, i);
      ctx.fillStyle = (i + Math.floor(i / L.n)) % 2 ? 'rgba(255,255,255,.14)' : 'rgba(70,120,40,.07)';
      ctx.fillRect(rc.x + 1, rc.y + 1, L.cell - 2, L.cell - 2);
      var s = parseSlime(S.cells[i]);
      if (srcS && s && i !== src && s.k === srcS.k && evolveOptions(s.k).length) {
        ctx.strokeStyle = '#2fbf3a';
        ctx.lineWidth = 3;
        ctx.setLineDash([6, 4]);
        ctx.strokeRect(rc.x + 3, rc.y + 3, L.cell - 6, L.cell - 6);
        ctx.setLineDash([]);
      }
      if (i === selected) {
        ctx.strokeStyle = '#E67E22';
        ctx.lineWidth = 3;
        ctx.strokeRect(rc.x + 2, rc.y + 2, L.cell - 4, L.cell - 4);
      }
    }
    ctx.strokeStyle = 'rgba(70,120,40,.25)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(L.ox, L.oy, L.cell * L.n, L.cell * L.n);
    if (S.ranches > 1) {
      ctx.font = '900 12px ' + FONT;
      ctx.fillStyle = '#5a3a1a';
      ctx.fillText(tf('ranchLabel', 'ぼくじょう{n}', { n: ranchPage + 1 }), L.ox + 2, L.oy - 4);
    }

    var tNow = now();
    for (i = L.base; i < L.base + L.n * L.n; i++) {
      var sl = parseSlime(S.cells[i]);
      if (!sl) continue;
      var rc2 = cellRect(L, i), r = slimeR(L, sl.k);
      var scale = 1;
      if (pops[i]) {
        var pa = (t - pops[i]) / 320;
        if (pa >= 1) delete pops[i];
        else scale = 1 + 0.3 * Math.sin(pa * Math.PI);
      }
      var mood = moodLevel(sl.care, tNow);
      ctx.globalAlpha = drag && drag.moved && drag.from === i ? 0.3 : 1;
      drawSlime(ctx, rc2.x + L.cell / 2, rc2.y + L.cell * 0.88, r, sl.k, { t: t, seed: i, shiny: sl.shiny, scale: scale, mood: mood });
      ctx.globalAlpha = 1;
      // しょんぼりの印（左上）と、エサで決めた進化先の印（右上）
      if (CARE_MARK[mood] || markTarget(sl)) {
        ctx.font = Math.round(L.cell * 0.26) + 'px ' + FONT;
        if (CARE_MARK[mood]) ctx.fillText(CARE_MARK[mood], rc2.x + 2, rc2.y + L.cell * 0.3);
        if (markTarget(sl)) ctx.fillText(FOOD_BY_ID[SPECIES[sl.k].evolve[sl.mark].need].icon, rc2.x + L.cell * 0.64, rc2.y + L.cell * 0.3);
      }
    }
    if (drag && drag.moved) {
      var ds = parseSlime(S.cells[drag.from]);
      if (ds) drawSlime(ctx, drag.x, drag.y + slimeR(L, ds.k), slimeR(L, ds.k) * 1.1, ds.k, { t: t, shiny: ds.shiny, squash: 0 });
    }
  }

  // ---- 場面: のはら ----
  var AREA_BG = {
    grass: ['#9fd8ff', '#d8f0ff', '#b9e68a', '#7cc242', '#8cc95e'],
    water: ['#8fd0ff', '#d9f2ff', '#9ad7f0', '#4aa3d8', '#7cc9a8'],
    fire: ['#ffb38a', '#ffe0c7', '#d9a37a', '#a0603a', '#7a4a30'],
    sky: ['#7fc4ff', '#e6f4ff', '#f4f8ff', '#dbe9ff', '#ffffff'],
    space: ['#141a4a', '#2c2f6e', '#b7aee0', '#8f86c8', '#a79ed6']
  };
  function drawField(t) {
    var a = fieldArea, bg = AREA_BG[a], bk = fieldBgKey(a), bgi = fieldBg(a);
    if (bgi) {
      var sk = SKY_ANIM[bk], su = SUN_SPIN[bk];
      if (sk && !reduced && skyAnim[bk] === undefined) skyAnim[bk] = buildSky(sk, bgi);
      if (su && !reduced && sunAnim[bk] === undefined) sunAnim[bk] = buildSun(su, bgi);
      var m = (sk && !reduced && skyAnim[bk]) ? drawSkyClouds(skyAnim[bk], t) : drawCover((su && !reduced && sunAnim[bk]) ? sunAnim[bk].clean : bgi);
      if (su && !reduced && sunAnim[bk]) drawSun(sunAnim[bk], m, t);
      if (!reduced && a === 'water') drawWaterSparkle(m, t);
      if (!reduced && bk === 'sakura') drawPetals(t);
      if (!reduced && a === 'space') drawSpaceStars(m, t);
    } else {
      var g = ctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, bg[0]);
      g.addColorStop(0.42, bg[1]);
      g.addColorStop(0.43, bg[2]);
      g.addColorStop(1, bg[3]);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = bg[4];
      if (a === 'fire') {
        ctx.beginPath();
        ctx.moveTo(W * 0.45, H * 0.43); ctx.lineTo(W * 0.68, H * 0.12); ctx.lineTo(W * 0.78, H * 0.12); ctx.lineTo(W, H * 0.43);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = '#ff7d2a';
        ctx.fillRect(W * 0.68, H * 0.1, W * 0.1, 6);
      } else {
        [[0.15, 90], [0.62, 120], [0.92, 70]].forEach(function (h) {
          ctx.beginPath();
          ctx.ellipse(h[0] * W, H * 0.44, h[1], 22, 0, Math.PI, Math.PI * 2);
          ctx.fill();
        });
      }
      if (a === 'water') {
        ctx.fillStyle = 'rgba(255,255,255,.35)';
        for (var wv = 0; wv < 6; wv++) ctx.fillRect((wv * 71 + (reduced ? 0 : t * 0.01)) % W, H * (0.55 + wv * 0.07), 30, 3);
      }
      ctx.fillStyle = 'rgba(255,255,255,.85)';
      [[0.17, 0.14, 20], [0.25, 0.12, 26], [0.33, 0.15, 18]].forEach(function (c) {
        ctx.beginPath();
        ctx.arc(c[0] * W, c[1] * H, c[2], 0, Math.PI * 2);
        ctx.fill();
      });
    }

    var ar = S.areas[a];
    if (!ar) return;
    var list = ar.wild;
    // 奥（上）から描いて手前が重なるようにする
    var idxs = list.map(function (_, i) { return i; }).sort(function (p, q) { return fxFor(a)[p].y - fxFor(a)[q].y; });
    idxs.forEach(function (i) {
      var w = wildPos(a, i, t);
      ctx.fillStyle = 'rgba(0,0,0,.13)';
      ctx.beginPath();
      ctx.ellipse(w.x, w.foot + 2, w.r * (1 - w.hop / 60), 5, 0, 0, Math.PI * 2);
      ctx.fill();
      var sq = reduced ? 0 : (w.hop < 1 ? -0.07 : 0.04);
      drawSlime(ctx, w.x, w.foot - w.hop, w.r, w.s.k, { t: t, seed: i, shiny: w.s.shiny, squash: sq });
      if (w.visitor) {
        ctx.font = '900 11px ' + FONT;
        ctx.textAlign = 'center';
        ctx.fillStyle = 'rgba(255,255,255,.9)';
        ctx.fillRect(w.x - 38, w.foot - w.hop - w.r * 2.6 - 16, 76, 16);
        ctx.fillStyle = '#7a2fb5';
        ctx.fillText(tx('visitor', 'おきゃくさん'), w.x, w.foot - w.hop - w.r * 2.6 - 4);
        ctx.textAlign = 'left';
      }
    });
    if (bubble && bubble.area === a && list[bubble.idx] && t - bubble.t0 < 2200) {
      var bw = wildPos(a, bubble.idx, t), by = bw.foot - bw.hop - bw.r * 2.6 - 10;
      ctx.globalAlpha = Math.min(1, (2200 - (t - bubble.t0)) / 400);
      ctx.font = '900 12px ' + FONT;
      ctx.textAlign = 'center';
      var bwid = Math.ceil(ctx.measureText(bubble.text).width) + 18;
      ctx.fillStyle = 'rgba(255,255,255,.95)';
      ctx.fillRect(bw.x - bwid / 2, by - 16, bwid, 20);
      ctx.beginPath();
      ctx.moveTo(bw.x - 5, by + 4);
      ctx.lineTo(bw.x + 5, by + 4);
      ctx.lineTo(bw.x, by + 11);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#B3560A';
      ctx.fillText(bubble.text, bw.x, by - 1);
      ctx.textAlign = 'left';
      ctx.globalAlpha = 1;
    }
    if (!list.length) {
      ctx.fillStyle = 'rgba(0,0,0,.55)';
      ctx.font = '900 13px ' + FONT;
      ctx.textAlign = 'center';
      ctx.fillText(tx('wildWaiting', '野生のスライムが来るのを待っています…'), W / 2, H * 0.7);
      ctx.textAlign = 'left';
    }
    if (catching && catching.area === a && list[catching.idx]) drawCatchRing(t);
  }

  function drawCatchRing(t) {
    var w = wildPos(catching.area, catching.idx, t);
    var cx = w.x, cy = w.foot - w.r * 1.1, R = w.r * 1.9 + 16;
    var start = -Math.PI / 2;
    ctx.lineWidth = 10;
    ctx.strokeStyle = 'rgba(255,255,255,.88)';
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.stroke();
    var a0 = start + catching.zoneStart * Math.PI * 2;
    ctx.strokeStyle = '#2fbf3a';
    ctx.beginPath();
    ctx.arc(cx, cy, R, a0, a0 + catching.zone * Math.PI * 2);
    ctx.stroke();
    var f = ((now() - catching.t0) / catching.lap) % 1;
    var ang = start + f * Math.PI * 2;
    ctx.fillStyle = '#E67E22';
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx + Math.cos(ang) * R, cy + Math.sin(ang) * R, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.font = '900 13px ' + FONT;
    ctx.textAlign = 'center';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(255,255,255,.9)';
    var ly = Math.max(16, cy - R - 12);
    var ringMsg = tx('catchRingTip', 'みどりでもう1回タップ！');
    ctx.strokeText(ringMsg, cx, ly);
    ctx.fillStyle = '#2b2b2b';
    ctx.fillText(ringMsg, cx, ly);
    ctx.textAlign = 'left';
  }

  // ---- 場面: とうばつ ----
  // 背景が絵になったので、地の文は白ふちで浮かせる（かざんの夜空や暗い岩の上でも読める）
  function outlinedText(s, x, y) {
    ctx.lineJoin = 'round';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(255,255,255,.85)';
    ctx.strokeText(s, x, y);
    ctx.fillText(s, x, y);
  }

  // とうばつの舞台。同じ のはら でも 6〜9体目は別の絵（bt_<area>2）、10体目ごとの おやぶん は専用の舞台（bt_oyabun）。
  // 31〜40 の ぎゃくしゅう は そのボスの系統の のはら の絵を同じ並びで使う。9枚を全部先に読むと重いので、いまのボスと次のボスのぶんだけ読む
  function bossBgKey(boss) {
    if (boss.n % 10 === 9) return 'bt_oyabun';
    return 'bt_' + boss.area + (boss.n % 10 >= 5 ? '2' : '');
  }
  function drawBattle(t) {
    var boss = battle ? battle.boss : (S.boss.cleared < BOSS_COUNT ? bossDef(S.boss.cleared) : bossDef(BOSS_COUNT - 1));
    var bgi = sceneBg(bossBgKey(boss));
    if (boss.n + 1 < BOSS_COUNT) sceneBg(bossBgKey(bossDef(boss.n + 1)));   // 次の舞台を先読み（勝った直後に切り替わっても絵が出る）
    if (bgi) {
      drawCover(bgi);
    } else {
      var g = ctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, '#ffe4c4');
      g.addColorStop(0.5, '#f7c59f');
      g.addColorStop(0.51, '#b9e68a');
      g.addColorStop(1, '#7cc242');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    }

    var waiting = !battle && bossWaiting();   // つぎの ぬし がまだ来ていない（舞台だけ見せて、ぬし は描かない）
    var members = battle ? battle.members : pickParty();
    // バーは本物。ボスのHPは「いま出せたダメージ」、みかたのHPはボスのつよさに比例して減る
    var p = 0, bossHp = 1, teamHp = 1, bPower = battle ? battle.power : boss.power;
    if (battle) {
      p = Math.min(1, (now() - battle.t0) / BATTLE_MS);
      bossHp = Math.max(0, 1 - battleDealt(now()) / bPower);
      teamHp = Math.max(0, 1 - Math.min(1, bPower / Math.max(1, battle.base * (1 + battle.bonus))) * p);
      if (battle.done) { if (battle.win) bossHp = 0; else teamHp = 0; }
    }
    var baseR = Math.min(W, H) * 0.058;
    members.forEach(function (m, i) {
      var lunge = battle && !battle.done && !reduced && Math.floor(t / 700) % 3 === i ? Math.max(0, Math.sin((t % 700) / 700 * Math.PI)) * W * 0.12 : 0;
      var x = W * (0.12 + i * 0.1) + lunge, foot = H * (0.62 + i * 0.09);
      ctx.fillStyle = 'rgba(0,0,0,.12)';
      ctx.beginPath();
      ctx.ellipse(x, foot + 3, baseR, 6, 0, 0, Math.PI * 2);
      ctx.fill();
      drawSlime(ctx, x, foot, baseR, m.k, { t: t, seed: i, shiny: m.shiny, hurt: battle && battle.done && !battle.win });
      // 3すくみが数字に埋もれて見えないので、その子が有利か不利かを本人の上に出す
      var tm = typeMult(SPECIES[m.k].line, boss.line);
      if (tm !== 1) {
        ctx.font = '900 11px ' + FONT;
        ctx.textAlign = 'center';
        ctx.fillStyle = 'rgba(255,255,255,.9)';
        ctx.fillRect(x - 16, foot - baseR * 2.5 - 12, 32, 14);
        ctx.fillStyle = tm > 1 ? '#2E8B57' : '#c0392b';
        ctx.fillText(tm > 1 ? tx('good', '有利') : tx('bad', '不利'), x, foot - baseR * 2.5 - 1);
        ctx.textAlign = 'left';
      }
    });
    var bx = W * 0.74, bfoot = H * 0.78, br = baseR * 1.6;
    var shake = battle && !battle.done && !reduced ? Math.sin(t * 0.05) * 2 : 0;
    if (!waiting) {
      ctx.fillStyle = 'rgba(0,0,0,.14)';
      ctx.beginPath();
      ctx.ellipse(bx, bfoot + 4, br * 1.2, 9, 0, 0, Math.PI * 2);
      ctx.fill();
      drawSlime(ctx, bx + shake, bfoot, br, boss.key, { t: t, seed: 7, boss: true, hurt: battle && battle.done && battle.win });
    }

    function bar(x, y, w, ratioHp, color, label) {
      ctx.fillStyle = 'rgba(255,255,255,.92)';
      ctx.fillRect(x, y, w, 12);
      ctx.fillStyle = color;
      ctx.fillRect(x + 2, y + 2, (w - 4) * Math.max(0, ratioHp), 8);
      ctx.strokeStyle = '#2b2b2b';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x, y, w, 12);
      ctx.fillStyle = '#2b2b2b';
      ctx.font = '900 11px ' + FONT;
      outlinedText(label, x, y - 4);
    }
    var bw = Math.min(170, W * 0.4);
    var tp = members.length ? partyPower(members, boss.line) : 0;
    var bench = benchCount(members.length);
    bar(14, 58, bw, teamHp, '#2fbf3a', tf('hudTeam', 'みかた {p}', { p: fmtBig(battle ? battle.base : tp) }) +
      (bench ? tf('hudCheer', '（おうえん +{v}%）', { v: Math.round(Math.min(BENCH_CAP, bench * BENCH_RATE) * 100) }) : ''));
    bar(W - bw - 14, 58, bw, bossHp, '#e53935', boss.name + ' ' + fmtBig(bPower));

    ctx.textAlign = 'center';
    ctx.font = '900 12px ' + FONT;
    ctx.fillStyle = 'rgba(0,0,0,.6)';
    outlinedText(tf('hudBoss', 'ボス {n} / {max}', { n: boss.n + 1, max: BOSS_COUNT }) +
      (boss.line === 'none' ? tx('hudNoType', '（むぞくせい）') : tf('hudLine', '（{l}の系統）', { l: LINE_NAME[boss.line] })), W / 2, 24);
    if (battle && !battle.done) {
      // 「きあい」ゲージ。みどりの窓で押すと かいしん。1往復に1回だけなので連打では勝てない
      var el = now() - battle.t0, gw = Math.min(220, W * 0.6), gx = W / 2 - gw / 2, gy = H - 40;
      var spent = Math.floor(el / SWEEP_MS) === battle.lastSweep;
      ctx.fillStyle = 'rgba(255,255,255,.92)';
      ctx.fillRect(gx, gy, gw, 18);
      ctx.fillStyle = spent ? '#dcdcdc' : '#b7e4a0';
      ctx.fillRect(gx + gw * (0.5 - CRIT_HALF), gy, gw * CRIT_HALF * 2, 18);
      ctx.strokeStyle = '#2b2b2b';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(gx, gy, gw, 18);
      var mx = gx + gw * gaugePos(el);
      ctx.fillStyle = spent ? '#aaa' : '#E67E22';
      ctx.fillRect(mx - 2, gy - 4, 4, 26);
      ctx.font = '900 11px ' + FONT;
      ctx.fillStyle = '#2b2b2b';
      outlinedText(spent ? tx('gaugeWait', 'つぎのおうえんを待とう') : tx('gaugeTap', 'みどりでタップ！'), W / 2, gy - 8);
      outlinedText(tf('gaugeCrit', 'かいしん {c}・つよさ +{v}%', { c: battle.crits, v: Math.round(battle.bonus * 100) }), W / 2, gy + 32);
      var cc = battle.charge;
      if (cc && !cc.done && el >= cc.at) {
        ctx.font = '900 15px ' + FONT;
        ctx.fillStyle = cc.broken ? '#2E8B57' : '#c0392b';
        outlinedText(cc.broken ? tx('chargeBroken', 'きあいをくじいた！') : tx('chargeUp', 'きあいをためている！ かいしんでくじけ！'), W / 2, H * 0.3);
      }
    } else if (battle && battle.done) {
      ctx.font = '900 30px ' + FONT;
      ctx.lineWidth = 5;
      ctx.strokeStyle = '#fff';
      var resultMsg = battle.win ? tx('win', 'かち！') : tx('lose', 'まけ…');
      ctx.strokeText(resultMsg, W / 2, H * 0.42);
      ctx.fillStyle = battle.win ? '#E67E22' : '#5a6b7a';
      ctx.fillText(resultMsg, W / 2, H * 0.42);
    } else if (waiting) {
      ctx.fillStyle = '#2b2b2b';
      ctx.font = '900 15px ' + FONT;
      outlinedText(tx('bossFarAway', 'つぎの ぬし は まだ とおくに いる…'), W / 2, H * 0.4);
      ctx.font = '900 13px ' + FONT;
      outlinedText(tf('bossArrivesIn', 'あと {t} で やってくる', { t: fmtTime(bossWaitMs(now())) }), W / 2, H * 0.4 + 24);
    } else if (!members.length) {
      ctx.fillStyle = '#2b2b2b';
      ctx.font = '900 13px ' + FONT;
      outlinedText(tx('noSlimeToFight', '牧場にスライムがいないと戦えません'), W / 2, H * 0.45);
    }
    ctx.textAlign = 'left';
  }

  // たんけん: 行き先の絵の上を、出した3匹が進みぐあいにあわせて右へ歩く。開いていないうちは暗くして条件を書く
  function drawTanken(t) {
    var trip = S.tanken.trip, dest = tankenDest(trip ? trip.dest : tkDest), bgi = sceneBg(dest.bg);
    if (bgi) {
      drawCover(bgi);
    } else {
      var g = ctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, dest.col[0]);
      g.addColorStop(1, dest.col[1]);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    }
    ctx.textAlign = 'center';
    if (!tankenOpen()) {
      ctx.fillStyle = 'rgba(0,0,0,.45)';
      ctx.fillRect(0, 0, W, H);
      ctx.font = '900 15px ' + FONT;
      ctx.fillStyle = '#333';
      outlinedText(tf('tankenLocked', '🔒 ボス{n}体を たおすと たんけんに行ける', { n: TANKEN_UNLOCK_BOSS }), W / 2, H * 0.48);
      outlinedText(tf('tankenProgress', 'いま {n}/{max}', { n: S.boss.cleared, max: TANKEN_UNLOCK_BOSS }), W / 2, H * 0.48 + 24);
      ctx.textAlign = 'left';
      return;
    }
    var members = trip ? trip.members : pickParty('none'), baseR = Math.min(W, H) * 0.058;
    var el = trip ? now() - trip.t0 : 0, p = trip ? Math.min(1, el / dest.ms) : 0, done = !!trip && el >= dest.ms;
    members.forEach(function (m, i) {
      var walk = trip && !done && !reduced ? Math.abs(Math.sin(t * 0.008 + i * 1.3)) * 6 : 0;
      var x = W * (0.16 + i * 0.13 + p * 0.4), foot = H * (0.72 + (i % 2) * 0.05);
      ctx.fillStyle = 'rgba(0,0,0,.15)';
      ctx.beginPath();
      ctx.ellipse(x, foot + 3, baseR, 6, 0, 0, Math.PI * 2);
      ctx.fill();
      drawSlime(ctx, x, foot - walk, baseR, m.k, { t: t, seed: i, shiny: m.shiny });
    });
    if (trip) {
      // できごと（25・50・75% を越えたとき）を浮かべる。途中から開いたときは、それまでの分は出さない
      if (tkSeen.t0 !== trip.t0) tkSeen = { t0: trip.t0, n: Math.min(3, Math.floor(p / 0.25)) };
      while (tkSeen.n < 3 && p >= (tkSeen.n + 1) * 0.25) { addFloat(W * 0.5, H * 0.42, '📝 ' + dest.ev[tkSeen.n], '#fff'); tkSeen.n++; }
      var bw = W - 28, bx = 14, by = 12;
      ctx.fillStyle = 'rgba(0,0,0,.35)';
      ctx.fillRect(bx, by, bw, 16);
      ctx.fillStyle = done ? '#ffb340' : '#5fd36a';
      ctx.fillRect(bx, by, bw * p, 16);
      ctx.font = '900 11px ' + FONT;
      ctx.fillStyle = '#fff';
      ctx.fillText(done ? tx('tankenBack', 'かえってきた！ けっかを見よう')
        : tf('tankenLeft', '{d}　のこり {t}', { d: dest.name, t: fmtTime(dest.ms - el) }), W / 2, by + 12);
    } else {
      ctx.font = '900 14px ' + FONT;
      ctx.fillStyle = '#333';
      outlinedText(tf('tankenGoTip', '「しゅっぱつ！」で {d} へ', { d: dest.name }), W / 2, H * 0.3);
    }
    ctx.textAlign = 'left';
  }

  function drawScene(t) {
    ctx.clearRect(0, 0, W, H);
    if (scene === 'ranch') drawRanch(t);
    else if (scene === 'field') drawField(t);
    else if (scene === 'tanken') drawTanken(t);
    else drawBattle(t);
    drawFx(t);
  }

  // ============================================
  // 行動（進化・合成・すみか・捕獲・とうばつ・買い物）
  // ============================================

  function spend(cost) {
    if (S.coins < cost) {
      flashTip(tx('noCoins', 'コインがたりないよ'));
      sfx('miss');
      return false;
    }
    S.coins -= cost;
    return true;
  }
  function afterChange() {
    recomputeCps();
    markDirty();
    saveGame();
  }
  function cellFxPos(i) {
    var L = ranchLayout(), rc = cellRect(L, i);
    return { x: rc.x + L.cell / 2, y: rc.y + L.cell * 0.5 };
  }

  // ---- 進化 ----
  // 進化先の決まり方: エサであげた指定 → 「つぎから聞かない」で覚えた好み → 候補が1つだけ。
  // どれも無ければ '' を返して askBranch で聞く
  function branchFor(a, b, opts) {
    var fed = markTarget(a) || markTarget(b);
    if (fed && opts.indexOf(fed) >= 0) return fed;
    var pref = a && S.pref[a.k];
    if (pref && opts.indexOf(pref) >= 0) return pref;
    return opts.length === 1 ? opts[0] : '';
  }

  function tryEvolve(from, to) {
    var a = parseSlime(S.cells[from]);
    var opts = evolveOptions(a.k);
    if (!opts.length) {
      flashTip(tf('noMoreEvolve', '<b>{n}</b>はこれ以上進化しないよ。ごうせい台の材料や、すみかの親にしよう', { n: SPECIES[a.k].name }));
      sfx('miss');
      return;
    }
    var pick = branchFor(a, parseSlime(S.cells[to]), opts);
    if (pick) { evolveInto(from, to, pick); return; }
    var before = S.cells[from] + '|' + S.cells[to];
    askBranch(a.k, opts, function (choice, remember) {
      if (remember) S.pref[a.k] = choice;
      // ダイアログを開いている間に動かされていたら何もしない
      if (S.cells[from] + '|' + S.cells[to] === before) evolveInto(from, to, choice);
    });
  }

  function evolveInto(from, to, k) {
    var a = parseSlime(S.cells[from]), b = parseSlime(S.cells[to]);
    if (!a || !b || a.k !== b.k) return;
    var shiny = a.shiny && b.shiny, mutated = false;
    if (SPECIES[a.k].stage >= 3 && Math.random() < oyabunRate(S.fac.spring)) {
      k = 'oyabun';
      mutated = true;
      S.oyabunMet++;
    }
    if (!shiny && Math.random() < shinyRate(S.fac.spring)) {
      shiny = true;
      mutated = true;
    }
    S.cells[from] = '';
    S.cells[to] = slimeStr(k, shiny, -1, now());   // 生まれたては ごきげん。エサで決めた進化先はここで使い切る
    S.merges++;
    if (mutated) S.mutations++;
    pops[to] = performance.now();
    if (selected === from || selected === to) selected = -1;
    if (scene === 'ranch') {
      var p = cellFxPos(to);
      burst(p.x, p.y, shiny ? '#ffe066' : '#8ce99a', 8);
      addFloat(p.x, p.y - 10, '+' + fmtBig(incomeOf(k, shiny) * facMult(S.fac) * (1 + 0.1 * S.shards)) + tx('perSec', '/秒'), '#2E8B57');
    }
    sfx('merge', { step: Math.min(SPECIES[k].stage * 3, 12) });
    registerDex(k, shiny);
    if (mutated) {
      showBanner(k === 'oyabun' ? tx('mutationOyabun', 'とつぜんへんい！おやぶんスライム！') : tx('mutationShiny', 'とつぜんへんい！きらきら！'), '#7a2fb5');
      sfx('fever');
    }
    afterChange();
  }

  // おまかせ進化: 同じ種類を2匹ずつ進化させる。きらきらは大事にとっておくので混ぜない
  function mergeAll() {
    var count = 0, again = true, guard = 0;
    while (again && guard++ < 60) {
      again = false;
      var seen = {};
      for (var i = 0; i < S.cells.length; i++) {
        var s = parseSlime(S.cells[i]);
        if (!s || s.shiny) continue;
        var opts = evolveOptions(s.k);
        if (!opts.length) continue;
        if (seen[s.k] === undefined) { seen[s.k] = i; continue; }
        var pick = branchFor(parseSlime(S.cells[seen[s.k]]), s, opts) || opts[Math.floor(Math.random() * opts.length)];
        evolveInto(seen[s.k], i, pick);
        delete seen[s.k];
        count++;
        again = true;
      }
    }
    return count;
  }

  // 牧場のマスに落とす: 同じ種類 → 進化 / 空き → 移動 / 違う種類 → 入れ替え（大事な子が事故で消えない）
  function dropOnCell(from, to) {
    if (from === to || from < 0 || !S.cells[from]) return;
    var sa = parseSlime(S.cells[from]), sb = parseSlime(S.cells[to]);
    if (sb && sa.k === sb.k) { tryEvolve(from, to); return; }
    var tmp = S.cells[to];
    S.cells[to] = S.cells[from];
    S.cells[from] = tmp || '';
    pops[to] = performance.now();
    sfx('place');
    afterChange();
  }

  var petWinAt = 0, petCount = 0;
  function pet(i) {
    var s = parseSlime(S.cells[i]);
    if (!s) return;
    pops[i] = performance.now();
    var t = now(), lv = moodLevel(s.care, t), p = cellFxPos(i);
    // なでると1段階もどる（やさぐれ → しょんぼり → ふつう → ごきげん）。
    // 連打の上限はコインだけにかけて、元気にする手はいつでも通す
    if (lv > 0) {
      S.cells[i] = reSlime(S.cells[i], null, t - CARE_STEPS[lv - 1]);
      recomputeCps();
      markDirty();
      addFloat(p.x, p.y - 26, tf('moodBecame', '{m}になった', { m: CARE_NAME[lv - 1] }), '#2E8B57');
      if (lv >= 2) sfx('levelup');
    }
    if (t - petWinAt >= 1000) { petWinAt = t; petCount = 0; }
    if (petCount >= TAP_CAP_PER_SEC) return;
    petCount++;
    var v = Math.max(1, cps * PET_RATE);
    addCoins(v);
    addFloat(p.x, p.y - 14, '+' + fmtBig(v));
    sfx('get');
  }

  // ---- エサをあげる ----
  // エサ1つで ごきげん にもどる。つぼみ・なみ・マグマ に「進化先の施設のエサ」をあげると、進化先もそれに決まる
  function feedSlime(i, id) {
    var s = parseSlime(S.cells[i]), f = FOOD_BY_ID[id];
    if (!s || !f) return;
    if (!S.fac[id] || !(S.food[id] > 0)) {
      flashTip(tf('noFood', '<b>{f}</b>がないよ（{b}でできる）', { f: f.name, b: FAC_BY_ID[id].name }));
      sfx('miss');
      return;
    }
    S.food[id]--;
    var br = foodBranch(s.k, id);
    S.cells[i] = reSlime(S.cells[i], br >= 0 ? br : null, now());
    pops[i] = performance.now();
    var p = cellFxPos(i);
    addFloat(p.x, p.y - 20, f.icon + tx('munch', ' もぐもぐ'), '#2E8B57');
    if (br >= 0) {
      flashTip(tf('foodBranchTip', '<b>{a}</b>は、もう1匹と重ねると <b>{b}</b> に進化するよ',
        { a: SPECIES[s.k].name, b: SPECIES[SPECIES[s.k].evolve[br].to].name }));
    }
    sfx('get');
    afterChange();
  }
  // みんなにごはん: コインでまとめて ごきげん にする（留守あけに1匹ずつなでなくていいように）
  function feedAllCost() { return Math.ceil(Math.max(30, cpsBase * 60)); }
  function feedAll() {
    var t = now(), list = [], i;
    for (i = 0; i < S.cells.length; i++) {
      var s = parseSlime(S.cells[i]);
      if (s && moodLevel(s.care, t) > 0) list.push(i);
    }
    if (!list.length) { flashTip(tx('allHappy', 'みんな ごきげんだよ！')); return; }
    if (!spend(feedAllCost())) return;
    list.forEach(function (j) {
      S.cells[j] = reSlime(S.cells[j], null, t);
      pops[j] = performance.now();
    });
    showBanner(tf('feedAllDone', 'みんなでごはん！ {n}匹が ごきげん になった', { n: list.length }), '#2E8B57');
    sfx('levelup');
    afterChange();
  }

  // ---- ごうせい台・すみかの枠（data-slot="g0" / "n0a" など） ----
  function slotRef(id) {
    if (id.charAt(0) === 'g') return { arr: S.gousei, key: +id.charAt(1) };
    var pair = S.nest.pairs[+id.charAt(1)];
    return pair ? { arr: pair, key: id.charAt(2), pair: pair } : null;
  }
  function putInSlot(from, id) {
    var ref = slotRef(id), str = S.cells[from];
    if (!ref || !str) return;
    if (id.charAt(0) === 'g' && !S.fac.gousei) return;
    S.cells[from] = ref.arr[ref.key] || '';
    ref.arr[ref.key] = str;
    if (ref.pair) ref.pair.startAt = 0;   // 親が変わったら時間は最初から
    selected = -1;
    sfx('place');
    afterChange();
  }
  function takeFromSlot(id) {
    var ref = slotRef(id);
    if (!ref || !ref.arr[ref.key]) return;
    if (addToRanch(ref.arr[ref.key]) < 0) {
      flashTip(tx('ranchFull', 'ぼくじょうがいっぱい！ ') + fullHint());
      return;
    }
    ref.arr[ref.key] = '';
    if (ref.pair) ref.pair.startAt = 0;
    sfx('place');
    afterChange();
  }

  function doGousei() {
    var a = parseSlime(S.gousei[0]), b = parseSlime(S.gousei[1]);
    if (!a || !b) { flashTip(tx('mixNeedTwo', 'ごうせい台に2匹入れてね')); return; }
    var k = a.k !== b.k ? RECIPES[recipeKey(a.k, b.k)] : null;
    if (!k) {
      [0, 1].forEach(function (j) {
        if (addToRanch(S.gousei[j]) >= 0) S.gousei[j] = '';
      });
      // 「なにも起きなかった」だけだと何が悪いのか分からない。ダメな理由を名指しする。
      // レシピ8つは「違う系統」でも「同じ段階」でもない（ほし＝たいよう＋かみなりは同系統）ので、
      // 嘘の規則は書かず、全レシピで本当に共通する「1段階目は使わない」だけを断定する
      var why;
      if (a.k === b.k) why = tx('mixSameKind', '<b>同じ種類</b>どうしは合成できないよ。牧場で重ねると<b>進化</b>するよ');
      else if (SPECIES[a.k].stage === 1 || SPECIES[b.k].stage === 1) why = tx('mixStage1', '<b>1段階目</b>のスライムを使うレシピは無いよ。もう少し育ててから入れてみよう');
      else why = tf('mixNoRecipe', '<b>{a}</b>と<b>{b}</b>のレシピは無いみたい…（レシピは全部で{all}つ・いま {have}つ見つけた。けいとうずタブで確認できるよ）',
        { a: SPECIES[a.k].name, b: SPECIES[b.k].name, all: RECIPE_LIST.length, have: S.recipes.length });
      flashTip(why + (S.gousei[0] || S.gousei[1] ? tx('mixKeptOnBench', '（牧場がいっぱいなので、ごうせい台にのこしたよ）') : tx('mixBackToRanch', '（2匹は牧場にもどったよ）')));
      sfx('miss');
      afterChange();
      return;
    }
    var shiny = Math.random() < shinyRate(S.fac.spring);
    var str = slimeStr(k, shiny, -1, now());
    S.gousei = ['', ''];
    var idx = addToRanch(str);
    if (idx < 0) S.gousei[0] = str;   // 満員なら枠に置いておく（タップで牧場へ）
    var newRecipe = S.recipes.indexOf(k) < 0;
    if (newRecipe) S.recipes.push(k);
    registerDex(k, shiny);
    showBanner((newRecipe ? tx('recipeFound', 'レシピはっけん！ ') : tx('mixed', 'ごうせい！ ')) + SPECIES[k].name, '#B3560A');
    sfx('combo');
    if (idx >= 0 && scene === 'ranch') {
      var p = cellFxPos(idx);
      burst(p.x, p.y, '#ffd166', 14);
    }
    if (shiny) {
      S.mutations++;
      showBanner(tx('bannerMutation', 'とつぜんへんい！きらきら！'), '#7a2fb5');
      sfx('fever');
    }
    afterChange();
  }

  function hatchNest(p) {
    var pair = S.nest.pairs[p];
    if (!pair || !pair.egg) return;
    var s = parseSlime(pair.egg);
    var idx = addToRanch(slimeStr(s.k, s.shiny, -1, now()));   // 生まれたては ごきげん
    if (idx < 0) { flashTip(tx('ranchFull', 'ぼくじょうがいっぱい！ ') + fullHint()); return; }
    pair.egg = '';
    pair.startAt = 0;
    S.bred++;
    showBanner(tx('hatched', 'ぱかっ！ ') + SPECIES[s.k].name, '#2E8B57');
    sfx('levelup');
    registerDex(s.k, s.shiny);
    if (s.shiny) showBanner(tx('shinyBorn', 'きらきらが生まれた！'), '#7a2fb5');
    afterChange();
  }

  // ---- 捕まえる ----
  function fieldTap(x, y) {
    var a = fieldArea, ar = S.areas[a];
    if (!ar) return;
    var t = performance.now();
    if (catching) {
      if (catching.area === a && ar.wild[catching.idx]) {
        var cw = wildPos(a, catching.idx, t), R = cw.r * 1.9 + 16;
        if (Math.hypot(x - cw.x, y - (cw.foot - cw.r * 1.1)) <= R + 44) { judgeCatch(); return; }
      }
      catching = null;
      flashTip(tx('catchCancel', '投げるのをやめたよ（あみはへっていない）'));
      return;
    }
    var best = -1, bestFoot = -1;
    ar.wild.forEach(function (_, i) {
      var w = wildPos(a, i, t);
      // 子どもの指の誤差ぶん、見た目より広く当てる
      if (Math.hypot(x - w.x, y - (w.foot - w.hop - w.r)) <= w.r * 1.6 && w.foot > bestFoot) {
        best = i;
        bestFoot = w.foot;
      }
    });
    if (best < 0) return;
    if (emptyCellIndex() < 0) {
      sayWild(a, best, tx('wildRanchFull', 'ぼくじょうがいっぱいだよ'));
      flashTip(tx('ranchFull', 'ぼくじょうがいっぱい！ ') + fullHint());
      sfx('miss');
      return;
    }
    if (S.nets < 1) {
      sayWild(a, best, tx('wildNoNet', 'あみがたりないよ'));
      flashTip(tf('noNetTip', 'あみがない！ つぎの回復まで {t}（下の「あみを買う」でも増やせる）',
        { t: fmtTime(netRegenMs(S.fac.netHut) - (now() - S.netAt)) }));
      sfx('miss');
      return;
    }
    var s = parseSlime(ar.wild[best].replace('*', ''));
    catching = { area: a, idx: best, t0: now(), zoneStart: 0.3 + Math.random() * 0.45, zone: catchZone(SPECIES[s.k].stage, s.shiny, S.netLv),
      lap: catchLapMs(SPECIES[s.k].stage, S.areas[a].lv) };
    sfx('bounce', { freq: 620 });
  }

  function judgeCatch() {
    var c = catching;
    catching = null;
    var ar = S.areas[c.area], str = ar.wild[c.idx];
    if (!str) return;
    S.nets--;
    var w = wildPos(c.area, c.idx, performance.now());
    var s = parseSlime(str.replace('*', ''));
    removeWild(c.area, c.idx);
    if (catchHit(now() - c.t0, c.zoneStart, c.zone, c.lap) && addToRanch(slimeStr(s.k, s.shiny, -1, now())) >= 0) {
      S.caught++;
      burst(w.x, w.foot - w.r, '#ffd166', 12);
      showBanner(tx('caught', 'つかまえた！ ') + SPECIES[s.k].name, '#B3560A');
      sfx('place');
      registerDex(s.k, s.shiny);
      if (s.shiny) showBanner(tx('shinyCaught', 'きらきらをつかまえた！'), '#7a2fb5');
    } else {
      addFloat(w.x, w.foot - w.r * 2.4, tx('escaped', 'にげられた…'), '#5a6b7a');
      sfx('splash');
    }
    afterChange();
  }

  // ---- とうばつ ----
  function currentBoss() { return bossDef(Math.min(S.boss.cleared, BOSS_COUNT - 1)); }
  // 31体目から50体目まで: ぬし が来るのを待つ区間
  function bossGated() { return S.boss.cleared >= BOSS_WAIT_FROM && S.boss.cleared < BOSS_COUNT; }
  function bossWaiting() { return bossGated() && S.boss.stock <= 0; }
  // あみ と同じ数え方（時刻で数えるので留守中も進む）。たまりきっている間は時計を止めておく。返すのは いま来た数
  function regenBoss(t) {
    var came = 0;
    while (S.boss.stock < BOSS_STOCK_MAX && t - S.boss.stockAt >= BOSS_REGEN_MS) {
      S.boss.stock++;
      S.boss.stockAt += BOSS_REGEN_MS;
      came++;
    }
    if (S.boss.stock >= BOSS_STOCK_MAX) S.boss.stockAt = t;
    return came;
  }
  function bossWaitMs(t) { return Math.max(0, BOSS_REGEN_MS - (t - S.boss.stockAt)); }

  // 牧場の全員を、相性まで入れた実際のつよさ順に並べる（マス番号つき）
  function partyList(line) {
    line = line || currentBoss().line;
    var t = now(), list = [];
    S.cells.forEach(function (c, i) {
      var s = parseSlime(c);
      if (!s) return;
      var mood = moodMult(s.care, t);
      list.push({ i: i, k: s.k, shiny: s.shiny, mood: mood, eff: powerOf(s.k, s.shiny, S.shards) * mood * typeMult(SPECIES[s.k].line, line) });
    });
    list.sort(function (p, q) { return q.eff - p.eff; });
    return list;
  }

  // えらんだ子を優先し、足りない分は強い順で埋める（えらんでいなければ全部自動）
  function pickParty(line) {
    line = line || currentBoss().line;
    var all = partyList(line), chosen = [], used = {}, j;
    (S.party || []).forEach(function (i) {
      for (var m = 0; m < all.length; m++) {
        if (all[m].i === i && !used[i] && chosen.length < 3) { chosen.push(all[m]); used[i] = 1; }
      }
    });
    for (j = 0; j < all.length && chosen.length < 3; j++) {
      if (!used[all[j].i]) { chosen.push(all[j]); used[all[j].i] = 1; }
    }
    return chosen;
  }

  // 戦いに出ない子のおうえん: 1匹 +2%・最大 +50%。
  // 上位3匹しか効かないと、スライムを増やしても つよさ がまったく動かなかった
  function benchCount(front) {
    var n = 0;
    S.cells.forEach(function (c) { if (parseSlime(c)) n++; });
    return Math.max(0, n - front);
  }
  function benchMult(front) { return 1 + Math.min(BENCH_CAP, benchCount(front) * BENCH_RATE); }
  function partyPower(members, line) { return teamPower(members, line, S.shards) * benchMult(members.length); }

  function startBattle() {
    if (battle && !battle.done) return;
    if (bossWaiting()) { flashTip(tf('bossNotHere', 'つぎの ぬし は まだ来ていないよ。あと <b>{t}</b>', { t: fmtTime(bossWaitMs(now())) })); sfx('miss'); return; }
    var boss = currentBoss(), members = pickParty(boss.line);
    if (!members.length) { flashTip(tx('noSlimeToFight2', '牧場にスライムがいないと戦えないよ')); return; }
    battle = {
      boss: boss, members: members, t0: now(), done: false, win: false,
      bonus: 0, taps: 0, crits: 0, lastSweep: -1, power: boss.power,
      // おやぶん（10体ごと）だけ「きあいため」をしてくる
      charge: boss.n % 10 === 9 ? { at: BATTLE_MS * 0.45, done: false, broken: false } : null,
      base: partyPower(members, boss.line) * (0.9 + Math.random() * 0.2)
    };
    S.boss.battles++;
    sfx('bossIn');
    markDirty();
  }

  // 「きあい」ゲージの位置（0=左, 1=右）。往復する
  function gaugePos(el) {
    var ph = (el % SWEEP_MS) / SWEEP_MS;
    return ph < 0.5 ? ph * 2 : (1 - ph) * 2;
  }
  // いま出せているダメージ。タップ0回なら合計がちょうど base になるので、
  // 「base >= ボスのつよさ なら勝ち」という元の勝敗式がそのまま残る（上乗せだけが増える）
  function battleDealt(t) {
    return battle.base * (1 + battle.bonus) * Math.min(1, (t - battle.t0) / BATTLE_MS);
  }

  // おうえん: 1往復に1回だけ効く。まんなかのみどりで押せば「かいしん」。
  // 連打で押し切れると、タイミングを計る意味がなくなるので回数で上限をかけない
  function cheerTap(x, y) {
    var el = now() - battle.t0, sweep = Math.floor(el / SWEEP_MS);
    if (sweep === battle.lastSweep) return;
    battle.lastSweep = sweep;
    battle.taps++;
    if (Math.abs(gaugePos(el) - 0.5) <= CRIT_HALF) {
      battle.crits++;
      battle.bonus += 0.04;
      addFloat(x, y, tx('critHit', 'かいしん！'), '#E67E22');
      burst(x, y, '#ffd166', 8);
      sfx('combo');
      // きあいをためている最中なら、かいしんでくじける
      if (battle.charge && !battle.charge.done && el >= battle.charge.at) battle.charge.broken = true;
    } else {
      battle.bonus += 0.01;
      addFloat(x, y, tx('cheerOn', 'がんばれ！'), '#2fbf3a');
      sfx('hit');
    }
  }

  var BEATEN_BY = { grass: 'fire', water: 'grass', fire: 'water' };
  function advHint(boss) {
    return boss.line === 'none' ? tx('advNone', 'むぞくせいのボスには、どの系統も有利・不利なし')
      : tf('advLine', '<b>{l}</b> の系統の子がいると有利', { l: LINE_NAME[BEATEN_BY[boss.line]] });
  }
  function updateBattle(t) {
    if (battle.done) {
      if (t - battle.doneAt > 3000) { battle = null; markDirty(); }
      return;
    }
    var boss = battle.boss, el = t - battle.t0, c = battle.charge;
    // おやぶんの「きあいため」。くじけなければ、そのあと ボスが 1.25倍 かたくなる
    if (c && !c.done && el >= c.at + CHARGE_MS) {
      c.done = true;
      if (c.broken) {
        showBanner(tx('bannerBreakCharge', 'きあいをくじいた！'), '#2E8B57');
        sfx('allclear');
      } else {
        battle.power = Math.ceil(battle.power * 1.25);
        showBanner(tf('bossCharging', '{n}が きあいをためた！', { n: boss.name }), '#e53935');
        sfx('bossIn');
      }
      markDirty();
    }
    var dealt = battleDealt(t);
    // ボスのHPが先に尽きたら、時間を待たずにその場で勝ち（つよい編成は一撃で終わる）
    if (el < BATTLE_MS && dealt < battle.power) return;
    battle.done = true;
    battle.doneAt = t;
    battle.win = dealt >= battle.power;
    if (battle.win) {
      S.boss.wins++;
      S.boss.streak++;
      burst(W * 0.74, H * 0.6, '#ff6b6b', 10);
      burst(W * 0.74, H * 0.6, '#74c0fc', 10);
      burst(W * 0.74, H * 0.6, '#ffd166', 10);
      sfx('levelup');
      // 初回撃破が本番の報酬。倒したボスへの再挑戦はその2割（くり返し戦う意味をつくる）
      var first = boss.n === S.boss.cleared && S.boss.cleared < BOSS_COUNT;
      var streakMul = 1 + Math.min(1, Math.max(0, S.boss.streak - 1) * 0.1);
      // 600秒ぶんだと1勝で数十分ぶん入り、ボス30体まで実プレイ約15分で終わった
      var reward = Math.ceil(Math.max(40 * (boss.n + 1), boss.stage * cpsBase * 60) * (first ? 1 : 0.2) * streakMul);
      addCoins(reward);
      var note = (S.boss.streak > 1 ? tf('winStreak', '（{n}れんしょう）', { n: S.boss.streak }) : '');
      if (first) {
        if (boss.n >= BOSS_WAIT_FROM) {   // 31体目からは、たおした ぬし の次が来るまで時間がかかる
          if (S.boss.stock >= BOSS_STOCK_MAX) S.boss.stockAt = t;
          S.boss.stock = Math.max(0, S.boss.stock - 1);
        }
        S.boss.cleared++;
        showBanner(tf('bossDefeated', 'ボスをたおした！ +{c}コイン', { c: fmtBig(reward) }) + note, '#B3560A');
        var opened = ensureAreas();
        if (opened.length) {
          showBanner(tf('areaOpened', '「{a}」ののはらが開いた！', { a: AREAS[opened[0]].name }), '#2E8B57');
          sfx('allclear');
        }
        if (S.boss.cleared === 30) {   // 3つの のはら のぬしを制覇（ここまでが本編。31体目からは ぎゃくしゅう と てんくう）
          S.shards += 3;
          S.title.boss = true;
          showBanner(tx('title30', 'ぬしをたおした者！ にじのかけら +3'), '#7a2fb5');
        }
        if (S.boss.cleared === BOSS_COUNT) {
          S.shards += 10;
          showBanner(tx('title50', 'てんくうのおやぶんをたおした！ にじのかけら +10'), '#7a2fb5');
        }
      } else {
        showBanner(tf('winAgain', 'かち！ +{c}コイン', { c: fmtBig(reward) }) + note, '#B3560A');
      }
    } else {
      S.boss.streak = 0;
      sfx('miss');
      var short = Math.max(1, Math.round((1 - dealt / battle.power) * 100));
      flashTip(tf('lostBy', 'まけちゃった… <b>あと {n}%</b> たりなかった。', { n: short }) + advHint(boss) +
        tx('lostTip', '／牧場の子を増やすと おうえん が強くなるよ'), 8000);
    }
    afterChange();
  }

  // ---- 買い物 ----
  function buyEgg(line) {
    if (!S.areas[line]) return;
    if (emptyCellIndex() < 0) { flashTip(tx('ranchFull', 'ぼくじょうがいっぱい！ ') + fullHint()); sfx('miss'); return; }
    if (!spend(eggPrice(line, S.eggLv, S.eggBought[line], cpsBase))) return;
    S.eggBought[line]++;
    S.bought++;
    var k = eggSpecies(line, S.eggLv);
    var i = addToRanch(slimeStr(k, false, -1, now()));
    if (scene === 'ranch') {
      var p = cellFxPos(i);
      burst(p.x, p.y, '#ffffff', 8);
    }
    sfx('pour');
    registerDex(k, false);
    afterChange();
  }

  function eggLvUp() {
    if (S.eggLv >= 3 || !stageFound(S.eggLv + 1)) return;
    if (!spend(eggLvCost(S.eggLv))) return;
    S.eggLv++;
    S.eggBought = { grass: 0, water: 0, fire: 0 };
    showBanner(tf('eggLvUp', 'タマゴLv{n}！', { n: S.eggLv }), '#B3560A');
    sfx('levelup');
    afterChange();
  }

  function facNeedMet(f) {
    var n = f.need;
    if (!n) return true;
    if (n.stage2 && !stageFound(2)) return false;
    if (n.dex && !S.dex[n.dex]) return false;
    if (n.area && !S.areas[n.area]) return false;
    if (n.caught && S.caught < n.caught) return false;
    if (n.dexCount && dexCount() < n.dexCount) return false;
    if (n.merges && S.merges < n.merges) return false;
    return true;
  }
  function facNeedText(f) {
    var n = f.need || {};
    if (n.stage2) return tx('needStage2', '2段階目のスライムを見つけると建てられる');
    if (n.dex) return tf('needDex', '{n}を見つけると建てられる', { n: SPECIES[n.dex].name });
    if (n.area) return tf('needArea', '「{a}」が開くと建てられる（ボス{n}体）', { a: AREAS[n.area].name, n: AREAS[n.area].unlockBoss });
    if (n.caught) return tf('needCaught', 'スライムを{n}匹捕まえると建てられる', { n: n.caught });
    if (n.dexCount) return tf('needDexCount', 'ずかんが{n}種になると建てられる', { n: n.dexCount });
    if (n.merges) return tf('needMerges', '進化を{n}回すると建てられる', { n: n.merges });
    return '';
  }

  function buyFacility(id) {
    var f = FAC_BY_ID[id], lv = S.fac[id] || 0;
    if (!f || lv >= f.secs.length || !facNeedMet(f)) return;
    if (!spend(facilityCost(f, lv, cpsBase))) return;
    S.fac[id] = lv + 1;
    if (id === 'nest') syncNestPairs();
    showBanner(tf('facBuilt', '{i} {n}{lv} ができた！',
      { i: f.icon, n: f.name, lv: f.secs.length > 1 ? ' Lv' + (lv + 1) : '' }), '#B3560A');
    sfx('levelup');
    afterChange();
  }

  function expandRanch() {
    if (S.size >= MAX_SIZE) return;
    if (!spend(expandCost(S.size, cpsBase))) return;
    var old = S.size, n = old + 1, cells = [];
    for (var p = 0; p < S.ranches; p++) {
      for (var r = 0; r < n; r++) {
        for (var c = 0; c < n; c++) cells.push(r < old && c < old ? S.cells[p * old * old + r * old + c] : '');
      }
    }
    S.size = n;
    S.cells = cells;
    selected = -1;
    pops = {};
    showBanner(tf('ranchExpanded', '牧場が {n}×{n} に広がった！', { n: n }), '#2E8B57');
    sfx('levelup');
    afterChange();
  }

  // 2026-09-17 夜「牧場がパンパンになったら ぼくじょう２を作って」: 7×7 まで広げたあとの2つ目の牧場。
  // S.cells の後ろに同じ数のマスを足すだけにして、収入・進化・エサ・すみか・おまかせ進化など S.cells を見る仕組みはそのまま使う。
  // 見せるときだけ ranchPage で前半/後半に分け、空きマスは前から埋まる（タマゴ・捕獲・たんけんの子は１が満員なら２へ入る）。
  // 選んだ子は覚えたままなので、チップで移ってから もう片方のマスをタップすると 引っこし・進化ができる
  function buyRanch2() {
    if (S.size < MAX_SIZE || S.ranches >= 2) return;
    if (!spend(ranch2Cost(cpsBase))) return;
    for (var i = 0; i < S.size * S.size; i++) S.cells.push('');
    S.ranches = 2;
    ranchPage = 1;
    selected = -1;
    showBanner(tx('ranch2Built', 'ぼくじょう２ ができた！ 上のチップで行き来できるよ'), '#2E8B57');
    sfx('levelup');
    afterChange();
  }

  function buyNet() {
    if (S.nets >= netMax(S.fac.netHut)) return;
    if (!spend(netPrice(cpsBase, S.netBought))) return;
    S.netBought++;
    S.nets++;
    sfx('get');
    afterChange();
  }
  function netLvUp() {
    if (S.netLv >= NET_LV_MAX) return;
    if (!spend(netLvCost(S.netLv, cpsBase))) return;
    S.netLv++;
    showBanner(tf('netLvUp', 'あみLv{n}！ みどりの範囲が広がった', { n: S.netLv }), '#2E8B57');
    sfx('levelup');
    afterChange();
  }
  function areaLvUp(a) {
    var ar = S.areas[a];
    if (!ar || ar.lv >= 3 || !slotFound(areaPool(a)[ar.lv])) return;
    if (!spend(areaLvCost(ar.lv, cpsBase))) return;
    ar.lv++;
    showBanner(tf('bannerAreaLv', '{a} Lv{n}！', { a: AREAS[a].name, n: ar.lv }), '#2E8B57');
    sfx('levelup');
    afterChange();
  }

  // たびだたせる: 進化しない種類を手放して120秒ぶんのコイン。
  // 600秒だと「くさのタマゴを買う→合成→手放す」の往復だけで、ボス10体のころにふつうの稼ぎの62倍になった
  function releaseValue(s) { return incomeOf(s.k, s.shiny) * facMult(S.fac) * (1 + 0.1 * S.shards) * 120; }
  // 進化する種類は「のはらにかえす」。進化先の施設がまだ買えない子で満員になると、捕獲もタマゴも止まって手が無くなるため、どの子でも手放せるようにする。
  // コインを出さないのは、タマゴを買ってすぐ手放す往復でもうけられないようにするため
  function releaseSlime(i) {
    var s = parseSlime(S.cells[i]);
    if (!s) return;
    var str = S.cells[i], sp = SPECIES[s.k], label = sp.name + (s.shiny ? tx('shinyTag', '（きらきら）') : '');
    if (!sp.evolve) {
      var v = releaseValue(s);
      askConfirm(tf('sendOffAsk', '<h3>たびだたせる？</h3><p>{n}を手放して<br><span class="sf-num">+{c}</span> コイン</p>',
        { n: label, c: fmtBig(v) }), tx('sendOff', 'たびだたせる'), function () {
        if (S.cells[i] !== str) return;
        S.cells[i] = '';
        selected = -1;
        addCoins(v);
        showBanner(tf('sentOff', 'いってらっしゃい！ +{c}', { c: fmtBig(v) }), '#B3560A');
        sfx('get');
        afterChange();
      });
      return;
    }
    var roomy = function () { var a = S.areas[sp.line]; return a && a.wild.length < WILD_MAX; };
    askConfirm(tf('releaseAsk', '<h3>のはらにかえす？</h3><p>{n}{tail}<br>コインはもらえません</p>',
      { n: label, tail: roomy() ? tx('releaseBack', 'を のはらにかえすよ<br>また捕まえることもできる')
        : tx('releaseGone', 'とおわかれするよ<br>（のはらがいっぱいなので、もどってこない）') }), tx('release', 'のはらにかえす'), function () {
      if (S.cells[i] !== str) return;
      S.cells[i] = '';
      selected = -1;
      if (roomy()) addWild(sp.line, str);
      showBanner(tx('seeYou', 'またね！'), '#2E8B57');
      sfx('get');
      afterChange();
    });
  }

  // 転生: にじのかけらを持って最初から。図鑑・レシピ・ボスの記録・称号・れんぞく日数は残す
  function doPrestige() {
    var gain = shardsFor(S.lifetime);
    if (!S.dex.rainbow || gain < 1) return;
    askConfirm(tf('prestigeAsk', '<h3>あたらしい牧場へ</h3><p>にじのかけら <span class="sf-num">+{n}</span><br>コイン・スライム・施設は最初からになります。<br>ずかん・レシピ・ボスの記録は残ります。</p>', { n: gain }),
      tx('prestigeGo', 'あたらしい牧場へ'), function () {
      var keep = S, g = shardsFor(keep.lifetime);
      S = defaultState();
      ['dex', 'recipes', 'boss', 'daily', 'title', 'pref', 'prestige', 'merges', 'mutations', 'shinyMet', 'oyabunMet', 'caught', 'bought', 'bred', 'startedAt', 'tanken'].forEach(function (k) { S[k] = keep[k]; });
      S.shards = keep.shards + g;
      S.prestige = keep.prestige + 1;
      S.areas.grass.lv = startAreaLv();
      wildFx = {};
      for (var i = 0; i < 3; i++) addWild('grass', rollWild('grass', S.areas.grass.lv));
      ensureAreas();
      catching = null;
      battle = null;
      selected = -1;
      ranchPage = 0;
      pops = {};
      showBanner(tf('prestigeDone', 'あたらしい牧場へ！ にじのかけら +{n}', { n: g }), '#7a2fb5');
      sfx('fever');
      afterChange();
    });
  }

  // ---- canvas の入力 ----
  function canvasXY(e) {
    var r = cv.getBoundingClientRect();
    return { x: (e.clientX - r.left) * W / r.width, y: (e.clientY - r.top) * H / r.height };
  }
  function cellAt(x, y) {
    var L = ranchLayout();
    var c = Math.floor((x - L.ox) / L.cell), r = Math.floor((y - L.oy) / L.cell);
    return c < 0 || r < 0 || c >= L.n || r >= L.n ? -1 : L.base + r * L.n + c;
  }
  function slotAtPoint(x, y) {
    var el = document.elementFromPoint(x, y);
    el = el && el.closest ? el.closest('[data-slot]') : null;
    return el ? el.getAttribute('data-slot') : null;
  }
  function highlightSlot(id) {
    var list = document.querySelectorAll('#sf-stations [data-slot]');
    for (var i = 0; i < list.length; i++) list[i].classList.toggle('drop-ok', list[i].getAttribute('data-slot') === id);
  }

  cv.addEventListener('pointerdown', function (e) {
    unlockAudio();
    var p = canvasXY(e);
    e.preventDefault();
    if (scene === 'field') { fieldTap(p.x, p.y); return; }
    if (scene === 'tanken') return;
    if (scene === 'battle') {
      if (battle && !battle.done) cheerTap(p.x, p.y);
      return;
    }
    var i = cellAt(p.x, p.y);
    drag = { from: i, pointerId: e.pointerId, sx: e.clientX, sy: e.clientY, x: p.x, y: p.y, moved: false, has: i >= 0 && !!S.cells[i] };
    if (drag.has) {
      try { cv.setPointerCapture(e.pointerId); } catch (err) { /* 古いブラウザ */ }
    }
  });
  cv.addEventListener('pointermove', function (e) {
    if (!drag || drag.pointerId !== e.pointerId || !drag.has) return;
    var p = canvasXY(e);
    drag.x = p.x;
    drag.y = p.y;
    if (!drag.moved && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) >= 6) {
      drag.moved = true;
      selected = -1;
    }
    if (drag.moved) highlightSlot(slotAtPoint(e.clientX, e.clientY));
  });
  cv.addEventListener('pointerup', function (e) {
    if (!drag || drag.pointerId !== e.pointerId) return;
    var d = drag;
    drag = null;
    highlightSlot(null);
    if (d.moved) {
      var slot = slotAtPoint(e.clientX, e.clientY);
      if (slot) { putInSlot(d.from, slot); return; }
      var p = canvasXY(e), to = cellAt(p.x, p.y);
      if (to >= 0) dropOnCell(d.from, to);
      return;
    }
    // ドラッグしなかった＝タップ。2タップ選択（1回目で選んで、2回目で相手）となでるを兼ねる
    var i = d.from;
    if (i >= 0 && selected >= 0 && selected !== i) {
      var from = selected;
      selected = -1;
      dropOnCell(from, i);
    } else if (i >= 0 && S.cells[i]) {
      pet(i);
      selected = selected === i ? -1 : i;
    } else {
      selected = -1;
    }
    markDirty();
  });
  cv.addEventListener('pointercancel', function () {
    drag = null;
    highlightSlot(null);
  });

  // ============================================
  // 画面（HUD・ひとこと・操作カード・タブパネル・ダイアログ）
  // ============================================

  var els = {
    root: document.getElementById('sf-root'),
    coins: document.getElementById('sf-coins'),
    cps: document.getElementById('sf-cps'),
    nets: document.getElementById('sf-nets'),
    netMax: document.getElementById('sf-netmax'),
    stage: document.getElementById('sf-stage'),
    chips: document.getElementById('sf-area-chips'),
    tip: document.getElementById('sf-tip'),
    stations: document.getElementById('sf-stations'),
    panel: document.getElementById('sf-panel'),
    modal: document.getElementById('sf-modal'),
    modalBox: document.getElementById('sf-modal-box')
  };
  var panelTab = 'egg';
  var dirty = true;
  var tipFlash = null;
  var autoReadyAt = 0;
  var autoAt = now() + 30000;
  var modalHandlers = {};

  function markDirty() { dirty = true; }
  function flashTip(html, ms) { tipFlash = { html: html, until: now() + (ms || 5000) }; markDirty(); }

  // 中身が変わったときだけ差し替える（毎回差し替えると、押している途中のボタンが消えてクリックが空振りする）
  function setHtml(el, html) {
    if (el.__html !== html) {
      el.__html = html;
      el.innerHTML = html;
    }
  }
  function img(k, cls) {
    return '<img src="' + spriteUrl(k) + '" alt="" class="' + (cls || '') + '" onerror="this.style.visibility=\'hidden\'">';
  }
  // 「みどりスライム」→「みどり」。英語は 'Green Slime' → 'Green'
  function shortName(k) { return SPECIES[k].name.replace(tx('slimeWord', 'スライム'), '').trim(); }

  function btn(act, label, opts) {
    opts = opts || {};
    return '<button type="button" class="sf-btn ' + (opts.cls || '') + '" data-act="' + act + '"' +
      (opts.arg != null ? ' data-arg="' + opts.arg + '"' : '') + (opts.disabled ? ' disabled' : '') + '>' + label + '</button>';
  }
  function costBtn(act, cost, arg) { return btn(act, fmtBig(cost) + tx('coinUnit', ' コイン'), { arg: arg, disabled: S.coins < cost }); }
  function row(icon, name, sub, button) {
    return '<div class="sf-row"><div class="sf-ic">' + icon + '</div><div class="sf-nm">' + name + '<small>' + sub + '</small></div>' + button + '</div>';
  }

  function renderHud() {
    var c = fmtBig(S.coins), p = '+' + fmtBig(cps), n = String(S.nets), m = '/' + netMax(S.fac.netHut);
    if (els.coins.textContent !== c) els.coins.textContent = c;
    if (els.cps.textContent !== p) els.cps.textContent = p;
    if (els.nets.textContent !== n) els.nets.textContent = n;
    if (els.netMax.textContent !== m) els.netMax.textContent = m;
  }

  function renderBadges() {
    var eggs = S.nest.pairs.filter(function (pr) { return pr.egg; }).length;
    setBadge('ranch', scene !== 'ranch' ? eggs : 0);
    setBadge('field', scene !== 'field' ? wildTotal() : 0);
    setBadge('battle', scene !== 'battle' && bossGated() ? S.boss.stock : 0);
    setBadge('tanken', scene !== 'tanken' && (tankenReady() || S.tanken.pending) ? 1 : 0);
  }
  function setBadge(name, n) {
    var b = document.querySelector('.sf-scene-tabs [data-scene="' + name + '"] .sf-badge');
    if (!b) return;
    b.hidden = !n;
    if (b.textContent !== String(n)) b.textContent = String(n);
  }

  // ---- canvas の下のひとこと ----
  function renderTip() {
    var html;
    if (tipFlash && now() < tipFlash.until) {
      html = '<span class="sf-tip-text">' + tipFlash.html + '</span>';
    } else if (scene === 'ranch' && selected >= 0 && parseSlime(S.cells[selected])) {
      var s = parseSlime(S.cells[selected]), sp = SPECIES[s.k], ev, fed = markTarget(s), lv = moodLevel(s.care, now());
      if (fed) ev = tf('evFed', 'エサで <b>{n}</b> に決めた。もう1匹と重ねると進化', { n: SPECIES[fed].name });
      else if (typeof sp.evolve === 'string') ev = tf('evOne', 'もう1匹と重ねると <b>{n}</b> に進化', { n: SPECIES[sp.evolve].name });
      else if (sp.evolve) ev = tx('evBranch', '進化先: ') + sp.evolve.map(function (b) {
        return tf('evBranchOne', '{n}（{f}）', { n: SPECIES[b.to].name, f: FOOD_BY_ID[b.need].icon + FOOD_BY_ID[b.need].name });
      }).join(tx('sep', '・'));
      else ev = tx('evNone', 'ごうせい台の材料や、すみかの親になれる');
      html = '<span class="sf-tip-text">' + tf('tipSlime', '<b>{n}</b>{shiny}　{line}・つよさ {power}・<b>{mood}</b>{care}', {
        n: sp.name, shiny: s.shiny ? ' ✨' : '', line: LINE_NAME[sp.line],
        power: fmtBig(powerOf(s.k, s.shiny, S.shards) * CARE_MULT[lv]), mood: CARE_NAME[lv],
        care: lv >= 1 ? tx('tipCheerUp', '（なでる・エサで ごきげん）') : ''
      }) + '<br>' + ev + '</span>' +
        btn('release', sp.evolve ? tx('release', 'のはらにかえす') : tx('sendOff', 'たびだたせる'));
    } else if (scene === 'field') {
      html = '<span class="sf-tip-text">' + tx('tipField', 'スライムをタップ → リングの目印が<b>みどり</b>に入ったら、もう1回タップ！ 段階が高い子・きらきらほどむずかしい') + '</span>';
    } else if (scene === 'tanken') {
      html = '<span class="sf-tip-text">' + tx('tipTanken', '行き先をえらんで、つよさ上位3匹を <b>たんけん</b> に出そう。行っているあいだも牧場は動くよ。つよい子ほど めずらしい子が見つかりやすい') + '</span>';
    } else if (scene === 'battle' && bossGated()) {
      html = '<span class="sf-tip-text">' + tf('tipBossWait', '31体目からの ぬし は <b>{h}時間に1体</b> やってくるよ（{n}体までは待っていてくれる）。まけても ぬし は帰らない。待つあいだは <b>たんけん</b> や ずかんあつめ で つよくなろう',
        { h: Math.round(BOSS_REGEN_MS / 3600000), n: BOSS_STOCK_MAX }) + '</span>';
    } else if (scene === 'battle') {
      html = '<span class="sf-tip-text">' + tx('tipBattle', '牧場のつよさ上位3匹が戦うよ。相性 <b>ほのお＞くさ＞みず＞ほのお</b> で1.5倍。バトル中はタップでおうえん') + '</span>';
    } else {
      var guide, sad = sadCount();
      if (S.merges === 0 && filledCount() <= 1) guide = tx('guideEgg', 'まずは下の「タマゴ」タブで <b>みどりのタマゴ</b> を買ってみよう');
      else if (S.merges === 0) guide = tx('guideMerge', '<b>同じ種類</b>をドラッグで重ねると <b>進化</b>！（タップで選んで、相手をタップしてもOK）');
      else if (S.caught === 0) guide = tx('guideField', '上の「<b>のはら</b>」で、野生のスライムを捕まえてみよう');
      else if (S.boss.battles === 0) guide = tx('guideBattle', '「<b>とうばつ</b>」でボスに挑戦！ 勝つとコインがもらえる');
      else if (emptyCellIndex() < 0) guide = tx('ranchFull', 'ぼくじょうがいっぱい！ ') + fullHint();
      else if (sad) guide = tf('guideSad', '<b>{n}匹</b>がしょんぼりしてる…　タップで<b>なでる</b>と1段階もどるよ（エサなら一気に元気）', { n: sad });
      else guide = tx('guidePet', 'スライムをタップで<b>なでる</b>とコイン。同じ種類を重ねると進化');
      html = '<span class="sf-tip-text">' + guide + '</span>' + (S.fac.auto ? btn('mergeAll', tx('mergeAll', 'まとめて進化'), { cls: 'green', disabled: now() < autoReadyAt }) : '');
    }
    setHtml(els.tip, html);
  }

  // ---- 操作カード（場面ごと） ----
  function slotHtml(id, str) {
    var s = parseSlime(str);
    return '<button type="button" class="sf-slot" data-slot="' + id + '" aria-label="' + tx('slotLabel', '枠') + '">' +
      (s ? img(s.k) + (s.shiny ? '<span class="sf-shiny-mark">✨</span>' : '') : '<span class="sf-slot-empty">＋</span>') + '</button>';
  }
  // エサのカード: たまっているエサ（押すと、牧場で選んだ子にあげる）と「みんなにごはん」
  function foodCardHtml() {
    var owned = FOODS.filter(function (f) { return S.fac[f.id]; });
    var mc = moodCounts(), notFine = mc[1] + mc[2] + mc[3], cost = feedAllCost();
    // 始めたばかりで施設もなく、みんな ごきげん のうちは出さない（最初の3分の導線を増やさない）
    if (!owned.length && !notFine) return '';
    var moodText = notFine ? CARE_NAME.map(function (nm, lv) { return mc[lv] ? CARE_MARK[lv] + nm + ' <b>' + mc[lv] + '</b>' : ''; }).filter(Boolean).join('・') : tx('allHappyShort', 'みんな ごきげん');
    var foot = '<div class="sf-slots"><p>' + moodText + '</p>' +
      btn('feedAll', tx('feedAll', 'みんなにごはん ') + fmtBig(cost), { cls: 'green', disabled: !notFine || S.coins < cost }) + '</div>';
    if (!owned.length) {
      return '<div class="sf-card wide lock"><h4>' + tx('foodTitle', 'エサ') + ' <span>🔒</span></h4>' +
        '<p>' + tx('foodLocked', '花だん・まるた・井戸・こおりのいえ・かがみ・ひらいしん を建てると、エサができる。エサをあげると元気になって、つぼみ・なみ・マグマは<b>進化先が決まる</b>') + '</p>' + foot + '</div>';
    }
    var chips = owned.map(function (f) {
      var n = S.food[f.id] || 0;
      return '<button type="button" class="sf-food" data-act="feed" data-arg="' + f.id + '"' + (n ? '' : ' disabled') + '>' +
        '<b>' + f.icon + '</b>' + f.name + '<i>' + n + '</i></button>';
    }).join('');
    return '<div class="sf-card wide"><h4>' + tx('foodTitle', 'エサ') + ' <span>' + (selected >= 0 ? tx('foodGiveSel', 'えらんだ子にあげる') : tx('foodPickOne', '牧場で1匹えらんでね')) + '</span></h4>' +
      '<div class="sf-foods">' + chips + '</div>' + foot + '</div>';
  }

  function renderStations() {
    var h = '';
    if (scene === 'ranch') {
      h += foodCardHtml();
      if (S.fac.gousei) {
        var ready = parseSlime(S.gousei[0]) && parseSlime(S.gousei[1]);
        h += '<div class="sf-card"><h4><i class="sf-fac-ttl">' + facIconHtml('gousei', '') + FAC_BY_ID.gousei.name + '</i><span>' + tx('mixSub', '違う種類を2匹') + '</span></h4><div class="sf-slots">' +
          slotHtml('g0', S.gousei[0]) + slotHtml('g1', S.gousei[1]) + btn('gousei', tx('mixGo', 'ごうせい！'), { disabled: !ready }) + '</div></div>';
      } else {
        h += '<div class="sf-card lock"><h4><i class="sf-fac-ttl">' + facIconHtml('gousei', '') + FAC_BY_ID.gousei.name + '</i><span>🔒</span></h4><p>' + tx('mixLocked', '「みずべ」が開くと、しせつタブで建てられる。違う種類を2匹かけ合わせると…？') + '</p></div>';
      }
      if (S.fac.nest) {
        S.nest.pairs.forEach(function (pr, p) {
          var right;
          if (pr.egg) right = btn('hatch', '<span class="sf-egg">🥚</span>', { arg: p, cls: 'green' });
          else if (parseSlime(pr.a) && parseSlime(pr.b)) right = '<span class="sf-timer">' + tx('nestTimer', 'タマゴまで') + '<br><b data-timer="nest' + p + '"></b></span>';
          else right = '<span class="sf-timer">' + tx('nestNeedTwo', '親を2匹<br>入れてね') + '</span>';
          h += '<div class="sf-card"><h4><i class="sf-fac-ttl">' + facIconHtml('nest', '') + FAC_BY_ID.nest.name + (S.nest.pairs.length > 1 ? ' ' + (p + 1) : '') + '</i><span>' + tx('nestSub', '親2匹 → タマゴ') + '</span></h4><div class="sf-slots">' +
            slotHtml('n' + p + 'a', pr.a) + slotHtml('n' + p + 'b', pr.b) + right + '</div></div>';
        });
      } else {
        h += '<div class="sf-card lock"><h4><i class="sf-fac-ttl">' + facIconHtml('nest', '') + FAC_BY_ID.nest.name + '</i><span>🔒</span></h4><p>' + tx('nestLocked', '2段階目のスライムを見つけると、しせつタブで建てられる。親2匹からタマゴが生まれる') + '</p></div>';
      }
    } else if (scene === 'field') {
      var ar = S.areas[fieldArea], nextSlot = ar.lv < 3 ? areaPool(fieldArea)[ar.lv] : null;
      var areaBtn = !nextSlot ? btn('', tx('maxLv', 'さいだいLv'), { cls: 'done', disabled: true })
        : !slotFound(nextSlot) ? btn('', '🔒 ' + tf('areaNeedFind', '{n}を見つける', { n: nextSlot.map(shortName).join(tx('orWord', ' か ')) }), { cls: 'lock', disabled: true })
        : costBtn('areaLv', areaLvCost(ar.lv, cpsBase), fieldArea);
      h += '<div class="sf-card wide"><h4>' + (sakuraField(fieldArea) ? tx('sakuraField', 'さくらの くさはら') : AREAS[fieldArea].name) + ' Lv' + ar.lv +
        ' <span>' + tf('wildCount', '野生 {n}/{max}', { n: ar.wild.length, max: WILD_MAX }) + tx('nextSpawn', '・つぎ ') + '<b data-timer="spawn"></b></span></h4>' +
        '<div class="sf-slots"><p>' + tx('areaLvTip', 'Lvが上がると、段階の高いスライムが出る') + '</p>' + areaBtn + '</div></div>';
      var max = netMax(S.fac.netHut);
      h += '<div class="sf-card"><h4>' + tx('netTitle', 'あみ') + ' ' + S.nets + '/' + max + ' <span data-timer="nets"></span></h4><div class="sf-slots">' +
        (S.nets >= max ? btn('', tx('netFull', 'まんたん'), { cls: 'done', disabled: true }) : costBtn('buyNet', netPrice(cpsBase, S.netBought))) + '</div></div>';
      h += '<div class="sf-card"><h4>' + tx('netLvTitle', 'あみLv') + ' ' + S.netLv + ' <span>' + tx('netLvSub', 'みどり +8%') + '</span></h4><div class="sf-slots">' +
        (S.netLv >= NET_LV_MAX ? btn('', tx('maxLv', 'さいだいLv'), { cls: 'done', disabled: true }) : costBtn('netLv', netLvCost(S.netLv, cpsBase))) + '</div></div>';
    } else if (scene === 'tanken') {
      h += tankenCardHtml();
    } else {
      var boss = currentBoss(), party = pickParty(boss.line);
      var tp = party.length ? partyPower(party, boss.line) : 0;
      var bench = benchCount(party.length);
      var fighting = battle && !battle.done;
      var waiting = !fighting && bossWaiting();
      var label = S.boss.cleared >= BOSS_COUNT ? tx('fightAgain', 'もう一度たたかう') : tx('fightStart', 'とうばつ開始！');
      var stockLine = !bossGated() ? ''
        : S.boss.stock >= BOSS_STOCK_MAX ? '<br>' + tf('stockFull', 'きている ぬし <b>{n}体</b>（まんたん）', { n: S.boss.stock })
        : S.boss.stock > 0 ? '<br>' + tf('stockSome', 'きている ぬし <b>{n}体</b>・つぎは ', { n: S.boss.stock }) + '<b data-timer="boss"></b>'
        : '<br>' + tx('stockNoneA', 'つぎの ぬし は ') + '<b data-timer="boss"></b>' + tx('stockNoneB', ' で やってくる');
      var names = party.map(function (m) { return shortName(m.k); }).join(tx('sep', '・'));
      h += '<div class="sf-card wide"><h4>' + tf('bossCardTtl', '{n}（{l}）', { n: boss.name, l: LINE_NAME[boss.line] }) +
        ' <span>' + tf('bossCardSub', 'ボス {n}/{max}・勝ち {w}/{b}回', { n: boss.n + 1, max: BOSS_COUNT, w: S.boss.wins, b: S.boss.battles }) +
        (S.boss.streak > 1 ? tf('bossCardStreak', '・{n}れんしょう', { n: S.boss.streak }) : '') + '</span></h4>' +
        '<div class="sf-slots"><p>' + tf('bossPower', 'ボスのつよさ <b>{p}</b>', { p: fmtBig(boss.power) }) + (boss.n % 10 === 9 ? tx('bossCharges', '（<b>きあいをためる</b>）') : '') +
        '<br>' + tf('ourPower', 'みかた <b>{p}</b>（{names}）', { p: fmtBig(tp), names: names || '—' }) +
        (bench ? '<br>' + tf('cheerLine', 'おうえん <b>+{v}%</b>（牧場の {n}匹）', { v: Math.round(Math.min(BENCH_CAP, bench * BENCH_RATE) * 100), n: bench }) : '') + stockLine + '</p>' +
        btn('party', tx('pickMembers', 'メンバーをえらぶ'), { disabled: fighting || !party.length }) +
        btn('battle', fighting ? tx('fighting', 'たたかい中…') : waiting ? tx('waitingBoss', 'ぬしを まっている…') : label, { cls: 'big', disabled: fighting || waiting || !party.length }) + '</div></div>';
    }
    setHtml(els.stations, h);
  }

  function updateTimers(t) {
    var list = els.stations.querySelectorAll('[data-timer]');
    for (var i = 0; i < list.length; i++) {
      var id = list[i].getAttribute('data-timer'), txt = '';
      if (id === 'nets') {
        txt = S.nets >= netMax(S.fac.netHut) ? '' : tx('nextWord', 'つぎ ') + fmtTime(netRegenMs(S.fac.netHut) - (t - S.netAt));
      } else if (id === 'spawn') {
        var ar = S.areas[fieldArea];
        txt = ar.wild.length >= WILD_MAX ? '—' : fmtTime(SPAWN_MS - (t - ar.spawnAt));
      } else if (id === 'boss') {
        txt = tx('inWord', 'あと ') + fmtTime(bossWaitMs(t));
      } else {
        var pr = S.nest.pairs[+id.slice(4)], a = pr && parseSlime(pr.a), b = pr && parseSlime(pr.b);
        if (a && b) txt = fmtTime(breedMs(a.k, b.k) - (t - (pr.startAt || t)));
      }
      if (list[i].textContent !== txt) list[i].textContent = txt;
    }
  }

  function renderChips() {
    els.chips.hidden = scene !== 'field' && scene !== 'tanken' && !(scene === 'ranch' && S.ranches > 1);
    if (els.chips.hidden) return;
    var h = '';
    if (scene === 'ranch') {
      var per = S.size * S.size;
      for (var rp = 0; rp < S.ranches; rp++) {
        var cnt = 0;
        for (var ci = rp * per; ci < (rp + 1) * per; ci++) if (S.cells[ci]) cnt++;
        h += '<button type="button" class="sf-chip' + (rp === ranchPage ? ' on' : '') + '" data-ranch="' + rp + '">🏡 ' + tf('ranchLabel', 'ぼくじょう{n}', { n: rp + 1 }) + ' ' + cnt + '/' + per + '</button>';
      }
      setHtml(els.chips, h);
      return;
    }
    if (scene === 'tanken') {
      // 行き先。たんけん中は いまの行き先だけ光る（変えられない）。まだ見つけていない子の行き先には ？ を添える
      if (!tankenOpen()) { setHtml(els.chips, '<span class="sf-chip lock">🔒 ' + tf('tankenChipLock', 'たんけん（ボス{n}体）', { n: TANKEN_UNLOCK_BOSS }) + '</span>'); return; }
      var cur = S.tanken.trip ? S.tanken.trip.dest : tkDest;
      TANKEN_DESTS.forEach(function (d) {
        h += '<button type="button" class="sf-chip' + (d.id === cur ? ' on' : '') + '" data-dest="' + d.id + '">' + d.icon + ' ' + d.name + ' ' + tankenFoundCount(d) + '/' + d.finds.length + '</button>';
      });
      setHtml(els.chips, h);
      return;
    }
    AREA_ORDER.forEach(function (a) {
      if (S.areas[a]) {
        h += '<button type="button" class="sf-chip' + (a === fieldArea ? ' on' : '') + '" data-area="' + a + '">' + (sakuraField(a) ? '🌸' : '') + AREAS[a].name + ' ' + S.areas[a].wild.length + '</button>';
      } else {
        h += '<span class="sf-chip lock">🔒 ' + tf('areaChipLock', '{a}（ボス{n}体）', { a: AREAS[a].name, n: AREAS[a].unlockBoss }) + '</span>';
      }
    });
    setHtml(els.chips, h);
  }

  // ---- タブパネル ----
  var PANELS = {
    egg: function () {
      var h = '<div class="sf-shop">';
      LINE_ORDER.forEach(function (line) {
        var k = eggSpecies(line, S.eggLv), open = !!S.areas[line];
        var name = EGG_NAME[line];
        h += row(img(k, open ? '' : 'sil'), name,
          open ? tf('eggHatches', '{n}が生まれる', { n: SPECIES[k].name }) : tf('eggLocked', '「{a}」が開くと買える', { a: AREAS[line].name }),
          open ? costBtn('egg', eggPrice(line, S.eggLv, S.eggBought[line], cpsBase), line)
            : btn('', '🔒 ' + tf('bossCountShort', 'ボス{n}体', { n: AREAS[line].unlockBoss }), { cls: 'lock', disabled: true }));
      });
      if (S.eggLv < 3) {
        var ok = stageFound(S.eggLv + 1);
        h += row('🥚', tx('eggLvTitle', 'タマゴLv ') + S.eggLv + ' → ' + (S.eggLv + 1),
          tf('eggLvDesc', '{n}段階目が生まれるようになる', { n: S.eggLv + 1 }) + (ok ? '' : tf('eggLvLocked', '（{n}段階目を見つけると買える）', { n: S.eggLv + 1 })),
          ok ? costBtn('eggLv', eggLvCost(S.eggLv)) : btn('', '🔒', { cls: 'lock', disabled: true }));
      }
      return h + '</div>';
    },
    fac: function () {
      var h = '<div class="sf-shop">';
      FACILITIES.forEach(function (f) {
        var lv = S.fac[f.id] || 0, multi = f.secs.length > 1, b;
        if (lv >= f.secs.length) b = btn('', tx('facBuiltMark', '✓ 建てた'), { cls: 'done', disabled: true });
        else if (!facNeedMet(f)) b = btn('', '🔒', { cls: 'lock', disabled: true });
        else b = costBtn('fac', facilityCost(f, lv, cpsBase), f.id);
        var name = f.name + (multi ? ' Lv' + lv + (lv < f.secs.length ? ' → ' + (lv + 1) : '') : '');
        var sub = facNeedMet(f) || lv ? f.desc : facNeedText(f);
        if (f.id === 'spring') sub += tf('springRate', '（きらきら {n}%）', { n: Math.round(shinyRate(lv) * 100) });
        h += row(facIconHtml(f.id, f.icon), name, sub, b);
      });
      // 満員のときタマゴは買えないので、タマゴタブに置くと「いちばん開かないタブ」に唯一の解決策が隠れる
      if (S.size < MAX_SIZE) {
        h += row('🏞️', tx('expandTitle', '牧場をひろげる ') + S.size + '×' + S.size + ' → ' + (S.size + 1) + '×' + (S.size + 1),
          tf('expandDesc', 'マスが {n} になる', { n: (S.size + 1) * (S.size + 1) }), costBtn('expand', expandCost(S.size, cpsBase)));
      } else if (S.ranches < 2) {
        h += row('🏡', tx('ranch2Title', 'ぼくじょう２をつくる'),
          tf('ranch2Desc', 'マスが 2倍（{n}）になる。上のチップで行き来', { n: S.size * S.size * 2 }), costBtn('ranch2', ranch2Cost(cpsBase)));
      }
      return h + '</div>';
    },
    dex: function () {
      var shinyN = Object.keys(S.dex).filter(function (k) { return S.dex[k].shiny; }).length;
      var h = '<div class="sf-dex-head">' + tx('dexTitle', 'スライムずかん') + ' <small>' + dexCount() + ' / ' + ORDER.length + tx('sep', '・') + '✨' + shinyN + '</small></div><div class="sf-dex">';
      ORDER.forEach(function (k) {
        var d = S.dex[k];
        h += '<button type="button" class="sf-dex-cell' + (d ? '' : ' unk') + '" data-act="dex" data-arg="' + k + '" title="' +
          (d ? SPECIES[k].name + ': ' + SPECIES[k].note : tx('dexUnknownTip', 'タップすると手に入れかたが見られる')) + '">' + img(k, d ? '' : 'sil') +
          (d && d.shiny ? '<span class="sf-shiny-mark">✨</span>' : '') + (d ? shortName(k) : tx('dexUnknown', '？？？')) + '</button>';
      });
      h += '</div><p class="sf-dex-note">' + tx('dexNote', 'スライムをタップすると、手に入れかたが見られるよ。進化・合成でも、同じ種類の親2匹から「すみか」で産ませても増やせるよ。') +
        (S.dex.oyabun ? '' : '<br>' + tx('dexNoteMutation', '？ とつぜんへんいでしか生まれないスライムがいるらしい…')) + '</p>';
      return h;
    },
    tree: function () { return '<div class="sf-tree-wrap">' + treeSvg() + '</div>'; },
    rebirth: function () {
      var gain = shardsFor(S.lifetime);
      var h = '<div class="sf-rebirth"><div class="big">🌈</div>' +
        tf('shardsLine', '<b>にじのかけら {n}</b>（しゅうにゅう・つよさ +{v}%）', { n: S.shards, v: S.shards * 10 }) + '<br>';
      if (!S.dex.rainbow) {
        h += tx('prestigeLocked', 'にじスライムを見つけると「あたらしい牧場へ」が開きます。<br>かけら1個ごとに しゅうにゅう・つよさ +10%。') + '<br>';
      } else {
        h += tf('prestigeGain', 'いま転生すると <b>+{n}</b> 個', { n: gain }) + '<br>' + btn('prestige', tx('prestigeGo', 'あたらしい牧場へ'), { cls: 'big', disabled: gain < 1 }) + '<br>';
      }
      h += '<small>' + tx('prestigeKeeps', 'ずかん・レシピ・倒したボスの記録は残ります') + '</small><br><br>' +
        tf('statsLine1', 'ボス {b}/{bmax}・レシピ {r}/{rmax}・れんぞく {d}日', { b: S.boss.cleared, bmax: BOSS_COUNT, r: S.recipes.length, rmax: RECIPE_LIST.length, d: S.daily.streak }) + '<br>' +
        tf('statsLine2', '捕まえた {c}・買った {b}・産ませた {r}・進化 {m}', { c: S.caught, b: S.bought, r: S.bred, m: S.merges }) +
        (S.title.boss ? '<br>🏅 ' + tx('titleBoss', 'ぬしをたおした者') : '') + (S.title.dex ? '<br>🏅 ' + tx('titleDex', 'スライムはかせ') : '') + '</div>';
      return h;
    }
  };

  // ---- 図鑑の説明（マスをタップで開く） ----
  var EGG_NAME = TEXT.eggNames || { grass: 'みどりのタマゴ', water: 'あおのタマゴ', fire: 'あかのタマゴ' };
  function nm(k) { return '<b>' + SPECIES[k].name + '</b>'; }
  // まだ見つけていない相手は名前を伏せて、系統と段階だけ教える（レシピ発見の楽しみを残しつつ、当てずっぽうにはしない）
  function hintNm(k) {
    return S.dex[k] ? nm(k) : tf('hintUnknown', '<b>？？？</b>（{l}の{n}段階目）', { l: LINE_NAME[SPECIES[k].line], n: SPECIES[k].stage });
  }
  function li(list) { return '<ul>' + list.map(function (s) { return '<li>' + s + '</li>'; }).join('') + '</ul>'; }
  function dexInfoHtml(k) {
    var sp = SPECIES[k], d = S.dex[k], line = sp.line, st = sp.stage;
    var base = !!LINE_BASE[line] && LINE_BASE[line].indexOf(k) >= 0;   // タマゴ・野生で出る1〜3段階目
    var ev = EVOLVE_FROM[k], how = [], next = [];
    if (base) {
      var areaName = AREAS[line].name;
      how.push('🥚 ' + tf('howEgg', 'タマゴタブの「{e}」', { e: EGG_NAME[line] }) + (st > 1 ? tf('howEggLv', '（タマゴLv{n} から）', { n: st }) : '') +
        (S.areas[line] ? '' : tf('howEggLocked', '。「{a}」が開くと買える（ボス{n}体）', { a: areaName, n: AREAS[line].unlockBoss })));
      how.push('🎣 ' + tf('howField', 'のはら「{a}」で捕まえる', { a: areaName }) +
        (st === 1 ? '' : st === 2 ? tx('howFieldLv2', '（Lv1では たまに・Lv2から よく出る）') : tx('howFieldLv3', '（のはらLv3 から）')));
      if (st > 1) how.push('🎁 ' + tf('howGuest', 'まいにち遊ぶと来る「おきゃくさん」（のはらLv{n} のとき）', { n: st - 1 }));
    }
    if (k === 'sakura') how.push('🎣 ' + tx('howSakura', 'のはら「くさはら」で捕まえる（いちど見つけたあと。さくらの くさはら になって 30% 出る）'));
    AREA_ORDER.forEach(function (a) {
      var pi = AREAS[a].pool ? AREAS[a].pool.map(function (slot) { return slot.indexOf(k) >= 0; }).indexOf(true) : -1;
      if (pi < 0) return;
      how.push('🎣 ' + tf('howFieldPool', 'のはら「{a}」で捕まえる（{c}）', {
        a: AREAS[a].name,
        c: pi === 0 ? tf('howPoolOpen', 'ボス{n}体で開く', { n: AREAS[a].unlockBoss }) : pi === 1 ? tx('howPoolCommon', 'Lv1では たまに・Lv2から よく出る') : tx('howPoolRare', 'のはらLv3 から')
      }));
    });
    if (sp.tanken) {
      var td = tankenDest(sp.tanken);
      var ri = td.finds.indexOf(k);
      var rarity = (TEXT.tankenRarity || ['（いちばん よく見つかる）', '（めずらしい）', '（とても めずらしい）'])[ri];
      how.push('🎒 ' + tf('howTanken', 'たんけん「{d}」（{t}）で見つかる{r}。ボス{n}体で開く。つよい子を出すほど 見つかりやすい', { d: td.name, t: fmtTime(td.ms), r: rarity, n: TANKEN_UNLOCK_BOSS }));
    }
    if (ev) {
      if (ev.need) {
        var food = FOOD_BY_ID[ev.need];
        how.push('🔼 ' + tf('howEvolveBranch', '{a} を2匹重ねて進化（{b} とどちらかになる）', { a: hintNm(ev.from), b: hintNm(ev.other) }));
        how.push(food.icon + ' ' + tf('howFood', '重ねる前に エサ「{f}」（{p}で作る）をあげておくと、かならずこの子になる', { f: food.name, p: FAC_BY_ID[ev.need].name }));
      } else {
        how.push('🔼 ' + tf('howEvolve', '{a} を2匹重ねて進化', { a: hintNm(ev.from) }));
      }
    }
    if (sp.recipe) {
      var r = sp.recipe, known = S.recipes.indexOf(k) >= 0;
      // レシピを知らないうちは材料の名前も段階も出さず、系統の組み合わせだけ（当てる楽しみを残す）
      var la = tf('lineSuffix', '{l}系', { l: LINE_NAME[SPECIES[r[0]].line] }), lb = tf('lineSuffix', '{l}系', { l: LINE_NAME[SPECIES[r[1]].line] });
      how.push('🧪 ' + tx('howRecipe', 'ごうせい台で ') +
        (known ? tf('howRecipeKnown', '{a} ＋ {b}', { a: nm(r[0]), b: nm(r[1]) })
          : la === lb ? tf('howRecipeSame', '<b>{l}</b>のスライムどうし', { l: la })
            : tf('howRecipeDiff', '<b>{a}</b> と <b>{b}</b> のスライム', { a: la, b: lb })) +
        (S.fac.gousei ? '' : tx('howRecipeLocked', '（ごうせい台は「みずべ」が開くと しせつタブで建てられる）')));
    }
    if (sp.mutation) {
      how.push('✨ ' + tf('howMutation', '3段階目より上のスライムを重ねて進化するとき、{p}% で とつぜんへんい', { p: (oyabunRate(S.fac.spring) * 100).toFixed(1).replace(/\.0$/, '') }));
      how.push('⛲ ' + tf('howSpring', '{f}を建てると出やすくなる', { f: FAC_BY_ID.spring.name }));
    }
    how.push('🏠 ' + tf('howNest', '{f}に この子の親2匹を入れると、同じ子のタマゴが生まれる', { f: FAC_BY_ID.nest.name }));

    var opts = evolveOptions(k);
    if (opts.length === 1) next.push('🔼 ' + tf('nextEvolve', '2匹重ねると {a} に進化', { a: nm(opts[0]) }));
    else if (opts.length > 1) next.push('🔼 ' + tf('nextEvolve2', '2匹重ねると {a} か {b} に進化（あげたエサで決まる）', { a: nm(opts[0]), b: nm(opts[1]) }));
    S.recipes.forEach(function (rk) {
      var rr = SPECIES[rk].recipe, i = rr.indexOf(k);
      if (i >= 0) next.push('🧪 ' + tf('nextRecipe', '{a} と合成すると {b}', { a: nm(rr[1 - i]), b: nm(rk) }));
    });
    if (k === 'rainbow') next.push('🌈 ' + tx('nextRainbow', '見つけると「あたらしい牧場へ」（転生）が開く'));
    if (k === 'sakura') next.push('🌸 ' + tx('nextSakura', '見つけると くさはら が「さくらの くさはら」になり、野生に さくら が 30% 出る'));
    if (!next.length) next.push(tx('nextNone', '進化はここまで。ごうせい台の材料や、すみかの親にしよう'));

    var cnt = 0;
    S.cells.forEach(function (c) { var s = parseSlime(c); if (s && s.k === k) cnt++; });
    return '<div class="sf-dexinfo">' + img(k, d ? '' : 'sil') +
      '<h3>' + (d ? sp.name + (d.shiny ? ' <span class="sf-shiny-mark">✨</span>' : '') : tx('dexUnknown', '？？？')) + '</h3>' +
      '<p class="sf-dexinfo-sub">' + (line === 'none' ? LINE_NAME[line] : tf('lineOf', '{l}系統', { l: LINE_NAME[line] })) + tf('stageOf', '・{n}段階目', { n: st }) +
        (d ? tf('dexStats', '・しゅうにゅう {i}/秒・つよさ {p}', { i: fmtBig(sp.income), p: fmtBig(speciesPower(k)) }) : '') + '</p>' +
      '<p class="sf-dexinfo-note">' + (d ? sp.note : tx('dexNotFound', 'まだ見つけていないスライム')) + '</p>' +
      '<h4>' + tx('howToGet', '手に入れかた') + '</h4>' + li(how) +
      (d ? '<h4>' + tx('whatNext', 'つぎにできること') + '</h4>' + li(next) +
        '<p class="sf-dexinfo-sub">' + tf('dexOwned', 'いま牧場に {n}匹', { n: cnt }) + (d.shiny ? tx('dexShinyFound', '・きらきら発見ずみ') : '') + '</p>' : '') +
      '</div>';
  }
  function openDexInfo(k) {
    if (!SPECIES[k]) return;
    openModal(dexInfoHtml(k) + '<div class="sf-modal-actions">' + btn('m-close', tx('close', 'とじる'), { cls: 'big' }) + '</div>', { 'm-close': closeModal });
  }

  // けいとうず: SPECIES から組み立てる（列＝段階、行＝系統、右にレシピ）
  function treeSvg() {
    var svgH = Math.max(520, 46 + Math.ceil(RECIPE_LIST.length / 2) * 56 + 22);   // 左は3系統＋てんくう＋うちゅう（2段）＋たんけん で 520、右はレシピ2列 × 行数（21個で 684）
    var s = '<svg width="660" height="' + svgH + '" viewBox="0 0 660 ' + svgH + '" font-size="10" font-weight="700" xmlns="http://www.w3.org/2000/svg">';
    s += '<defs><marker id="sf-arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="M0 0 L6 3 L0 6 z" fill="#8a847a"/></marker></defs>';
    function node(x, y, k) {
      var d = S.dex[k];
      return (d ? '<image href="' + spriteUrl(k) + '" x="' + (x - 15) + '" y="' + (y - 17) + '" width="30" height="30"/>'
        : '<circle cx="' + x + '" cy="' + y + '" r="12" fill="#bdb7ad"/><text x="' + x + '" y="' + (y + 4) + '" text-anchor="middle" fill="#fff" font-size="12">?</text>') +
        '<text x="' + x + '" y="' + (y + 25) + '" text-anchor="middle" fill="' + (d ? '#333' : '#999') + '">' + (d ? shortName(k) : tx('dexUnknown', '？？？')) + '</text>';
    }
    ['grass', 'water', 'fire'].forEach(function (line, li) {
      var y = 40 + li * 84, base = LINE_BASE[line], br = SPECIES[base[2]].evolve;
      s += '<text x="6" y="' + (y + 4) + '" fill="#8a4a12" font-size="11">' + LINE_NAME[line] + '</text>';
      base.forEach(function (k, i) {
        var x = 64 + i * 76;
        if (i) s += '<line x1="' + (x - 62) + '" y1="' + y + '" x2="' + (x - 16) + '" y2="' + y + '" stroke="#8a847a" stroke-width="2" marker-end="url(#sf-arrow)"/>';
        s += node(x, y, k);
      });
      br.forEach(function (b, i) {
        var x = 64 + 3 * 76, yy = y + (i ? 22 : -22);
        s += '<path d="M' + (64 + 2 * 76 + 16) + ' ' + y + ' Q ' + (x - 30) + ' ' + yy + ' ' + (x - 17) + ' ' + yy + '" fill="none" stroke="#8a847a" stroke-width="2" marker-end="url(#sf-arrow)"/>' +
          node(x, yy, b.to) + '<text x="' + (x + 19) + '" y="' + (yy + 3) + '" fill="#8a847a" font-size="9">(' + FOOD_BY_ID[b.need].name + ')</text>';
      });
    });
    // てんくう: 野生でしか会えない むぞくせい の3種（かぜ → つき → てんし。枝分かれなし）
    var sy = 40 + 3 * 84;
    s += '<text x="6" y="' + (sy + 4) + '" fill="#8a4a12" font-size="9">' + tx('treeSky', 'てんくう') + '</text>';
    ['kaze', 'tsuki', 'tenshi'].forEach(function (k, i) {
      var x = 64 + i * 76;
      if (i) s += '<line x1="' + (x - 62) + '" y1="' + sy + '" x2="' + (x - 16) + '" y2="' + sy + '" stroke="#8a847a" stroke-width="2" marker-end="url(#sf-arrow)"/>';
      s += node(x, sy, k);
    });
    // うちゅう: いんせき → すいせい → ブラックホール と、単独の どせい・うちゅうじん（2段目）
    var uy = sy + 84;
    s += '<text x="6" y="' + (uy + 4) + '" fill="#8a4a12" font-size="9">' + tx('treeSpace', 'うちゅう') + '</text>';
    ['inseki', 'suisei', 'blackhole'].forEach(function (k, i) {
      var x = 64 + i * 76;
      if (i) s += '<line x1="' + (x - 62) + '" y1="' + uy + '" x2="' + (x - 16) + '" y2="' + uy + '" stroke="#8a847a" stroke-width="2" marker-end="url(#sf-arrow)"/>';
      s += node(x, uy, k);
    });
    ['dosei', 'alien'].forEach(function (k, i) { s += node(64 + i * 76, uy + 50, k); });
    // たんけん: 行き先3つでしか会えない3種（進化しない）
    var ty = uy + 100;
    s += '<text x="6" y="' + (ty + 4) + '" fill="#8a4a12" font-size="9">' + tx('treeTanken', 'たんけん') + '</text>';
    ['obake', 'golem', 'mimic'].forEach(function (k, i) { s += node(64 + i * 76, ty, k); });
    s += '<line x1="392" y1="10" x2="392" y2="' + (svgH - 10) + '" stroke="#e2cfae" stroke-dasharray="4 4"/>';
    s += '<text x="404" y="20" fill="#8a4a12" font-size="11">' + tf('treeRecipes', 'ごうせい台のレシピ {n}/{max}', { n: S.recipes.length, max: RECIPE_LIST.length }) + '</text>';
    RECIPE_LIST.forEach(function (k, i) {
      var x = 404 + (i % 2) * 128, y = 46 + Math.floor(i / 2) * 56, known = S.recipes.indexOf(k) >= 0, r = SPECIES[k].recipe;
      s += '<text x="' + x + '" y="' + (y + 4) + '" fill="' + (known ? '#333' : '#aaa') + '">' + (known ? shortName(r[0]) + ' ＋ ' + shortName(r[1]) : '？ ＋ ？') + '</text>';
      s += '<text x="' + x + '" y="' + (y + 19) + '" fill="' + (known ? '#B3560A' : '#aaa') + '">＝ ' + (known ? SPECIES[k].name : tx('dexUnknown', '？？？')) + '</text>';
    });
    s += '<text x="404" y="' + (svgH - 10) + '" fill="#7a2fb5">✨ ' + (S.dex.oyabun ? tx('treeLegendKnown', 'おやぶん: とつぜんへんいで生まれる') : tx('treeLegend', '？: とつぜんへんいでしか生まれない')) + '</text>';
    return s + '</svg>';
  }

  function renderPanel() {
    setHtml(els.panel, PANELS[panelTab]());
  }

  function renderAll() {
    renderTip();
    renderStations();
    renderChips();
    renderPanel();
    renderBadges();
  }

  // ---- ダイアログ ----
  function openModal(html, handlers, cls) {
    modalHandlers = handlers || {};
    els.modalBox.className = 'sf-modal-box' + (cls ? ' ' + cls : '');
    els.modalBox.innerHTML = html;
    els.modal.hidden = false;
    var first = els.modalBox.querySelector('button');
    // 読み込み直後の「おかえり」でページがゲーム枠まで飛ばないように
    if (first) first.focus({ preventScroll: true });
  }
  function closeModal() {
    els.modal.hidden = true;
    modalHandlers = {};
  }
  function askConfirm(html, okLabel, onOk) {
    openModal(html + '<div class="sf-modal-actions">' + btn('m-cancel', tx('cancel', 'やめる'), { cls: 'lock' }) + btn('m-ok', okLabel, { cls: 'big' }) + '</div>', {
      'm-ok': function () { closeModal(); onOk(); },
      'm-cancel': closeModal
    });
  }
  function askBranch(k, opts, cb) {
    var h = '<h3>' + tx('branchTitle', 'どっちに進化する？') + '</h3><p>' + tf('branchBody', '{n}の進化先をえらんでね', { n: SPECIES[k].name }) + '</p><div class="sf-choice">';
    opts.forEach(function (o) { h += '<button type="button" data-act="m-pick" data-arg="' + o + '">' + img(o) + SPECIES[o].name + '</button>'; });
    h += '</div><label class="sf-remember"><input type="checkbox" id="sf-remember"> ' + tx('branchRemember', 'つぎから聞かない') + '</label>';
    openModal(h, {
      'm-pick': function (arg) {
        var remember = !!(document.getElementById('sf-remember') || {}).checked;
        closeModal();
        cb(arg, remember);
      }
    });
  }
  function tankenOpen() { return S.boss.cleared >= TANKEN_UNLOCK_BOSS; }
  function tankenReady() {
    var trip = S.tanken.trip;
    return !!trip && now() - trip.t0 >= tankenDest(trip.dest).ms;
  }
  function tankenChance(dest, power) {
    if ((S.tanken.miss[dest.id] || 0) >= TANKEN_PITY) return 1;
    return dest.rate * Math.min(1, 0.3 + 0.7 * power / dest.need);
  }
  function tankenCoins(dest) { return Math.max(100, Math.round(cpsBase * dest.ms / 1000 * TANKEN_COIN_RATE)); }
  function tankenFoundCount(dest) { return dest.finds.filter(function (k) { return !!S.dex[k]; }).length; }
  // 見つかる子をえらぶ。ふつう:めずらしい:とてもめずらしい＝5:3:2。まだ図鑑にない子は2倍にして、通いつづければ3種そろうようにする
  function tankenPick(dest) {
    var ws = dest.finds.map(function (k, i) { return TANKEN_FIND_W[i] * (S.dex[k] ? 1 : 2); });
    var r = Math.random() * ws.reduce(function (a, b) { return a + b; }, 0);
    for (var i = 0; i < ws.length; i++) { r -= ws[i]; if (r < 0) return dest.finds[i]; }
    return dest.finds[0];
  }
  function tankenNames(members) {
    return members.map(function (m) { return shortName(m.k) + (m.shiny ? '✨' : ''); }).join(tx('sep', '・'));
  }
  function startTanken() {
    if (!tankenOpen() || S.tanken.trip) return;
    var party = pickParty('none');
    if (!party.length) { flashTip(tx('tkNoSlime', '牧場にスライムがいないと たんけんに行けないよ')); sfx('miss'); return; }
    var dest = tankenDest(tkDest);
    // 出発時のつよさで確率を決める（途中で牧場を入れかえても変わらない）
    S.tanken.trip = { dest: dest.id, t0: now(), power: Math.round(partyPower(party, 'none')),
      members: party.map(function (m) { return { k: m.k, shiny: m.shiny }; }) };
    tkNotified = false;
    showBanner(tf('bannerTankenGo', 'たんけんたい しゅっぱつ！ → {d}', { d: dest.name }), '#2E8B57');
    sfx('bossIn');
    afterChange();
  }
  function cancelTanken() {
    if (!S.tanken.trip) return;
    askConfirm('<h3>' + tx('tkRecallTitle', 'よびもどす？') + '</h3><p>' + tx('tkRecallBody', 'いま よびもどすと、コインも スライムも もらえないよ') + '</p>', tx('tkRecall', 'よびもどす'), function () {
      S.tanken.trip = null;
      flashTip(tx('tkRecalled', 'たんけんたいが もどってきた'));
      afterChange();
    });
  }
  function claimTanken() {
    var trip = S.tanken.trip;
    if (!trip || !tankenReady()) return;
    var dest = tankenDest(trip.dest), coins = tankenCoins(dest);
    addCoins(coins);
    var miss = S.tanken.miss[dest.id] || 0, hit = Math.random() < tankenChance(dest, trip.power);
    var h = '<h3>🎒 ' + tx('tkResultTitle', 'たんけんの けっか') + '</h3><p>' + tf('tkResultWho', '{d}（{m}）', { d: dest.name, m: tankenNames(trip.members) }) +
      '</p><div class="sf-num">+' + fmtBig(coins) + ' ' + tx('coin', 'コイン') + '</div>';
    if (hit) {
      var fk = tankenPick(dest), shiny = Math.random() < shinyRate(S.fac.spring), str = slimeStr(fk, shiny, -1, now());
      S.tanken.miss[dest.id] = 0;
      S.tanken.found++;
      registerDex(fk, shiny);
      var idx = addToRanch(str);
      if (idx < 0) S.tanken.pending = str;   // 満員なら たんけんタブで待たせて、マスが空いたら入れる
      h += '<p>' + img(fk) + '<br>' + tf('tkJoined', '<b>{n}</b>{s} が なかまになった！', { n: SPECIES[fk].name, s: shiny ? tx('shinyMark', ' ✨きらきら！') : '' }) +
        (idx < 0 ? '<br>' + tx('tkRanchFull', '（牧場がいっぱいなので、マスをあけてから たんけんタブの「牧場に入れる」）') : '') + '</p>';
      sfx('get');
    } else {
      S.tanken.miss[dest.id] = miss + 1;
      h += '<p>' + tf('tkMiss', 'めずらしい子は 見つからなかった…<br>あと {n}回までに かならず見つかるよ', { n: TANKEN_PITY - miss }) + '</p>';
    }
    S.tanken.done++;
    S.tanken.trip = null;
    openModal(h + btn('m-ok', tx('close', 'とじる'), { cls: 'big' }), { 'm-ok': closeModal });
    afterChange();
  }
  function takeTankenPending() {
    var str = S.tanken.pending;
    if (!str) return;
    var idx = addToRanch(str);
    if (idx < 0) { flashTip(tx('ranchFull', 'ぼくじょうがいっぱい！ ') + fullHint()); sfx('miss'); return; }
    S.tanken.pending = '';
    showBanner(tf('bannerCameToRanch', '{n} が 牧場に来た！', { n: SPECIES[parseSlime(str).k].name }), '#2E8B57');
    sfx('place');
    afterChange();
  }
  function tankenCardHtml() {
    var tk = S.tanken, trip = tk.trip, h = '';
    if (!tankenOpen()) {
      return '<div class="sf-card wide"><h4>🎒 ' + tx('tkWord', 'たんけん') + ' <span>' + tf('tkUnlockChip', 'ボス{n}体で開く', { n: TANKEN_UNLOCK_BOSS }) + '</span></h4>' +
        '<div class="sf-slots"><p>' + tf('tkUnlockBody', 'とうばつで ボスを {n}体 たおすと、たんけんたい を出せるよ（いま {c}/{n}）。行き先ごとに、そこでしか会えない子がいる',
          { n: TANKEN_UNLOCK_BOSS, c: S.boss.cleared }) + '</p></div></div>';
    }
    if (tk.pending) {
      var ps = parseSlime(tk.pending);
      h += '<div class="sf-card wide"><h4>🎒 ' + tx('tkBrought', 'つれてかえった子') + ' <span>' + tx('tkPutIn', '牧場に入れてね') + '</span></h4><div class="sf-slots"><p>' +
        img(ps.k) + ' ' + tf('tkWaiting', '<b>{n}</b>{s} が 待っているよ', { n: SPECIES[ps.k].name, s: ps.shiny ? ' ✨' : '' }) + '</p>' +
        btn('tkTake', tx('tkTake', '牧場に入れる'), { cls: 'big' }) + '</div></div>';
    }
    var dest = tankenDest(trip ? trip.dest : tkDest);
    if (trip) {
      var el = now() - trip.t0, done = el >= dest.ms, p = Math.min(1, el / dest.ms), log = [];
      dest.ev.forEach(function (e, i) { if (p >= (i + 1) * 0.25) log.push('📝 ' + e); });
      h += '<div class="sf-card wide"><h4>' + (done ? '🎉 ' + tx('tkReturned', 'かえってきた！') : '🎒 ' + tf('tkOnTrip', 'たんけん中 {d}', { d: dest.name })) +
        ' <span>' + (done ? dest.name : tx('tkLeft', 'のこり ') + fmtTime(dest.ms - el)) + '</span></h4>' +
        '<div class="sf-slots"><p>' + tankenNames(trip.members) + '<br>' +
        (done ? tx('tkSeeResult', 'けっかを見よう！') : (log.length ? log.join('<br>') : tx('tkDeparted', 'しゅっぱつした！'))) + '</p>' +
        (done ? btn('tkClaim', tx('tkClaim', 'けっかを見る'), { cls: 'big' }) : btn('tkCancel', tx('tkRecall', 'よびもどす'))) + '</div></div>';
      return h;
    }
    var party = pickParty('none'), power = party.length ? Math.round(partyPower(party, 'none')) : 0;
    var chance = tankenChance(dest, power), miss = tk.miss[dest.id] || 0;
    var finds = dest.finds.map(function (k) { return S.dex[k] ? img(k) + shortName(k) : tx('dexUnknown', '？？？'); }).join(tx('sep', '・'));
    h += '<div class="sf-card wide"><h4>' + dest.icon + ' ' + dest.name + ' <span>' + fmtTime(dest.ms) + '</span></h4><div class="sf-slots">' +
      '<p>' + tf('tkOnlyHere', 'ここでしか会えない子（{n}/{max}）: ', { n: tankenFoundCount(dest), max: dest.finds.length }) +
      '<span class="sf-tk-finds"><b>' + finds + '</b></span><br>' +
      '<small>' + tx('tkFindsHint', '左の子ほど よく見つかる。まだ会っていない子は 見つかりやすい') + '</small><br>' +
      (miss >= TANKEN_PITY ? tx('tkPity', 'つぎは かならず見つかる！')
        : tf('tkChance', 'みつかりやすさ {n}%', { n: Math.round(chance * 100) }) +
          (power < dest.need ? tf('tkChanceMax', '（つよさ {p} で最大）', { p: fmtBig(dest.need) }) : '')) +
      '<br>' + tf('tkCoins', 'もらえるコイン: 約 {c}', { c: fmtBig(tankenCoins(dest)) }) +
      '<br>' + tx('tkTakeWith', 'つれていく: ') +
      (party.length ? tf('tkPartyPower', '{m}（つよさ {p}）', { m: tankenNames(party), p: fmtBig(power) }) : tx('tkNobody', 'いない')) + '</p>' +
      btn('party', tx('pickMembers', 'メンバーをえらぶ'), { disabled: !party.length }) +
      btn('tkGo', tx('tkGo', 'しゅっぱつ！'), { cls: 'big', disabled: !party.length }) + '</div></div>';
    return h;
  }

  // とうばつ（たんけん）に出す3匹をえらぶ。えらばなければ強い順で自動（おまかせで自動に戻せる）。えらんだ3匹は とうばつ と たんけん で共通
  function askParty() {
    var tk = scene === 'tanken', boss = tk ? null : currentBoss(), line = tk ? 'none' : boss.line, all = partyList(line);
    if (!all.length) { flashTip(tx('noSlime', '牧場にスライムがいないよ')); return; }
    var sel = pickParty(line).map(function (m) { return m.i; });
    function render() {
      var h = '<h3>' + tf('partyTitle', '{w}に出す3匹', { w: tk ? tx('tkWord', 'たんけん') : tx('battleWord', 'とうばつ') }) +
        ' <small>' + sel.length + '/3</small></h3><p>' +
        (tk ? tx('partyTkHint', 'つよい子ほど めずらしい子が見つかりやすい')
          : tf('partyBossHint', '<b>{n}</b>は{l}{a}', {
            n: boss.name,
            l: boss.line === 'none' ? tx('bossNoLine', ' むぞくせい。') : tf('bossLineIs', '「{l}」の系統。', { l: LINE_NAME[boss.line] }),
            a: advHint(boss)
          })) +
        tx('partyTapPick', '。タップでえらぶ') + '</p><div class="sf-party">';
      all.forEach(function (m) {
        var tm = typeMult(SPECIES[m.k].line, line), at = sel.indexOf(m.i);
        h += '<button type="button" class="sf-party-card' + (at >= 0 ? ' on' : '') + '" data-act="m-tog" data-arg="' + m.i + '">' +
          (at >= 0 ? '<span class="sf-party-num">' + (at + 1) + '</span>' : '') + img(m.k) +
          '<b>' + shortName(m.k) + (m.shiny ? '✨' : '') + '</b>' +
          '<small>' + tx('powerWord', 'つよさ ') + fmtBig(Math.round(m.eff)) + '</small>' +
          (tm > 1 ? '<small class="adv">' + tx('advGood', '有利') + '</small>' : tm < 1 ? '<small class="dis">' + tx('advBad', '不利') + '</small>' : '') +
          (m.mood < 1 ? '<small class="dis">' + tx('moodWeak', 'よわってる') + '</small>' : '') + '</button>';
      });
      h += '</div><div class="sf-modal-actions">' + btn('m-auto', tx('partyAuto', 'おまかせ'), { cls: 'lock' }) + btn('m-ok', tx('partyOk', 'これでいく'), { cls: 'big' }) + '</div>';
      openModal(h, {
        'm-tog': function (arg) {
          var i = +arg, at = sel.indexOf(i);
          if (at >= 0) sel.splice(at, 1);
          else if (sel.length < 3) sel.push(i);
          else { sel.shift(); sel.push(i); }   // 4匹目を押したら、いちばん古い選択と入れかえる
          render();
        },
        'm-auto': function () { S.party = []; closeModal(); afterChange(); },
        'm-ok': function () { S.party = sel.slice(0, 3); closeModal(); afterChange(); }
      }, 'wide');
    }
    render();
  }

  function showWelcome(info, daily) {
    var h = '<h3>' + tx('welcomeTitle', 'おかえり！') + '</h3><p>' + tx('welcomeSub', '留守のあいだに') + '</p>' +
      '<div class="sf-num">+' + fmtBig(info.coins) + ' ' + tx('coin', 'コイン') + '</div><ul>' +
      '<li>🌿 ' + tf('welcomeWild', 'のはらに野生のスライム {n}匹', { n: wildTotal() }) + '</li>' +
      (info.eggs ? '<li>🥚 ' + tf('welcomeEggs', 'すみかにタマゴ {n}個', { n: info.eggs }) + '</li>' : '') +
      '<li>🎣 ' + tx('netTitle', 'あみ') + ' ' + S.nets + '/' + netMax(S.fac.netHut) + '</li>' +
      (info.sad ? '<li>💧 ' + tf('welcomeSad', 'しょんぼりしている子 {n}匹（なでる・エサで元気になるよ）', { n: info.sad }) + '</li>' : '') +
      (tankenReady() ? '<li>🎒 ' + tx('welcomeTanken', 'たんけんたいが かえってきた！（たんけんタブ）') + '</li>' : '') +
      (bossGated() && S.boss.stock > 0 ? '<li>⚔️ ' + tf('welcomeNushi', 'とうばつに ぬし が {n}体 きているよ', { n: S.boss.stock }) + '</li>' : '');
    if (daily) {
      h += '<li>🎁 ' + tf('dailyGuest', 'きょうのおきゃくさんが「{a}」に来ているよ', { a: AREAS[daily.area].name }) + '</li>' +
        '<li>📅 ' + (daily.cont ? tf('welcomeStreak', 'れんぞく {n}日目！', { n: daily.streak }) : tx('welcomeThanks', 'また来てくれてありがとう')) + '</li>';
    }
    openModal(h + '</ul>' + btn('m-ok', tx('welcomePlay', 'あそぶ'), { cls: 'big' }), { 'm-ok': closeModal });
  }

  // ---- クリック（ボタン・枠・タブ） ----
  var ACTIONS = {
    dex: openDexInfo,
    egg: buyEgg,
    eggLv: eggLvUp,
    expand: expandRanch,
    ranch2: buyRanch2,
    fac: buyFacility,
    buyNet: buyNet,
    netLv: netLvUp,
    areaLv: areaLvUp,
    gousei: doGousei,
    feed: function (arg) {
      if (selected < 0 || !parseSlime(S.cells[selected])) { flashTip(tx('feedPickOne', 'エサをあげる子を、牧場でタップして選んでね')); return; }
      feedSlime(selected, arg);
    },
    feedAll: feedAll,
    hatch: function (arg) { hatchNest(+arg); },
    battle: startBattle,
    party: askParty,
    tkGo: startTanken,
    tkClaim: claimTanken,
    tkCancel: cancelTanken,
    tkTake: takeTankenPending,
    prestige: doPrestige,
    release: function () { if (selected >= 0) releaseSlime(selected); },
    mergeAll: function () {
      if (now() < autoReadyAt) return;
      autoReadyAt = now() + 10000;
      var n = mergeAll();
      flashTip(n ? tf('mergeAllDone', 'まとめて {n}回 進化したよ', { n: n }) : tx('mergeAllNone', '進化できる組がないよ（きらきらはまとめて進化しない）'));
    }
  };

  els.root.addEventListener('click', function (e) {
    var t = e.target;
    var act = t.closest('[data-act]');
    if (act && !act.disabled) {
      var name = act.getAttribute('data-act'), arg = act.getAttribute('data-arg');
      if (modalHandlers[name]) modalHandlers[name](arg);
      else if (ACTIONS[name]) ACTIONS[name](arg);
      return;
    }
    var slot = t.closest('[data-slot]');
    if (slot) {
      var id = slot.getAttribute('data-slot');
      if (selected >= 0) putInSlot(selected, id);
      else takeFromSlot(id);
      return;
    }
    var sc = t.closest('[data-scene]');
    if (sc) { setScene(sc.getAttribute('data-scene')); return; }
    var pt = t.closest('[data-panel]');
    if (pt) {
      panelTab = pt.getAttribute('data-panel');
      var tabs = document.querySelectorAll('.sf-panel-tabs button');
      for (var i = 0; i < tabs.length; i++) tabs[i].classList.toggle('on', tabs[i] === pt);
      els.panel.scrollTop = 0;
      renderPanel();
      return;
    }
    var rc = t.closest('[data-ranch]');
    if (rc) {
      ranchPage = Math.min(S.ranches - 1, +rc.getAttribute('data-ranch') || 0);
      drag = null;
      markDirty();
      return;
    }
    var dc = t.closest('[data-dest]');
    if (dc) {
      if (S.tanken.trip) flashTip(tx('tkCantChange', 'たんけん中は 行き先を変えられないよ'));
      else { tkDest = dc.getAttribute('data-dest'); markDirty(); }
      return;
    }
    var ch = t.closest('[data-area]');
    if (ch) {
      fieldArea = ch.getAttribute('data-area');
      catching = null;
      markDirty();
    }
  });

  function setScene(name) {
    if (scene === name) return;
    scene = name;
    if (window.GameAudio) window.GameAudio.setBgm(sceneBgm(), BGM_VOLUME);   // 鳴っている最中ならフェードで次の曲へ
    catching = null;
    selected = -1;
    drag = null;
    floats.length = 0;
    var tabs = document.querySelectorAll('.sf-scene-tabs button');
    for (var i = 0; i < tabs.length; i++) {
      var on = tabs[i].getAttribute('data-scene') === name;
      tabs[i].classList.toggle('on', on);
      tabs[i].setAttribute('aria-selected', on ? 'true' : 'false');
    }
    markDirty();
  }

  // ---- 音 ----
  // BGM は場面ごとに替える（2026-09-18「音楽が和風のお祭りぽい。各シーンで音楽変えて」。それまでは きんぎょ 1曲）。
  // BGMer の8曲のうち、ぼくじょう=陽気（のんびり）・のはら=かけっこ（走りまわる）・とうばつ=刹那（はりつめる）・たんけん=空想（ふしぎ）。
  // どれも他のゲームで本番に置いてある曲なので新しい転送は無い。game.js は英語版と共用しうるので絶対パス
  var SCENE_BGM = { ranch: 'youki', field: 'kakekko', battle: 'setsuna', tanken: 'kuusou' };
  var BGM_VOLUME = 0.35;
  function sceneBgm() { return '/games/assets/bgm/' + (SCENE_BGM[scene] || SCENE_BGM.ranch) + '.mp3'; }
  var audioStarted = false;
  function unlockAudio() {
    if (!window.GameAudio) return;
    window.GameAudio.unlock();
    if (!audioStarted) {
      audioStarted = true;
      window.GameAudio.startBgm();
    }
  }

  // ============================================
  // メインループ（setInterval 100ms）
  // ============================================
  var lastTickAt = now(), saveTimer = 0, uiTimer = 0;
  function tick() {
    var t = now(), dt = (t - lastTickAt) / 1000;
    lastTickAt = t;
    if (dt <= 0) return;
    // スリープ復帰や裏タブの間は留守と同じ50%（開きっぱなしの人と閉じた人をそろえる）
    if (dt > 120 || document.hidden) addCoins(offlineGain(dt * 1000, cpsFull));
    else addCoins(cps * dt);
    regenNets(t);
    if (regenBoss(t) && bossGated()) {
      showBanner(tx('bannerNushiCame', 'あたらしい ぬしが やってきた！'), '#c0392b');
      sfx('bossIn');
      markDirty();
    }
    growFood(t);
    if (spawnWild(t)) markDirty();
    progressNest(t);
    if (catching && t - catching.t0 > RING_LAP_MS * 5) {
      catching = null;
      flashTip(tx('ringGone', 'リングが消えちゃった。もう一度タップしてね'));
    }
    if (battle) updateBattle(t);
    if (!tkNotified && tankenReady()) {   // 帰ってきた合図（開いている間に時間が来たとき・開いた直後に1回）
      tkNotified = true;
      showBanner(tx('bannerTankenBack', 'たんけんたいが かえってきた！'), '#2E8B57');
      sfx('levelup');
      markDirty();
    }
    if ((S.fac.auto || 0) >= 2 && t >= autoAt) {
      autoAt = t + 30000;
      if (!drag && selected < 0 && !(battle && !battle.done)) {
        var n = mergeAll();
        if (n) flashTip(tf('autoMergeDone', 'おまかせ進化で {n}回 進化したよ', { n: n }));
      }
    }
    if (tipFlash && t >= tipFlash.until) { tipFlash = null; markDirty(); }
    saveTimer += dt;
    if (saveTimer >= 10) {
      saveTimer = 0;
      recomputeCps();   // 時間がたつと ごきげん が下がるので、何もしていなくても秒収入を追いかける
      saveGame();
      reportProgress();
    }
    renderHud();
    uiTimer += dt;
    if (dirty || uiTimer >= 0.5) {
      uiTimer = 0;
      dirty = false;
      renderAll();
    }
    updateTimers(t);
  }

  function frame(t) {
    drawScene(t);
    requestAnimationFrame(frame);
  }

  // ============================================
  // 初期化
  // ============================================
  var loaded = loadGame();
  S = loaded.state;
  syncNestPairs();
  ensureAreas();
  sceneBg(bossBgKey(currentBoss()));   // いまのボスの舞台を先に読んでおく（とうばつを開いた瞬間に絵が出るように）
  if (loaded.fresh) {
    for (var wi = 0; wi < 3; wi++) addWild('grass', rollWild('grass', 1));
  }
  recomputeCps();
  var away = loaded.fresh ? null : applyOffline();
  var daily = checkDaily();
  if (loaded.fresh && daily) daily = null;   // 初回はおきゃくさんの説明をしない（最初の3分は導線を1本に）
  if (away && away.elapsed >= 60 * 1000) {
    showWelcome(away, daily);
  } else if (daily) {
    flashTip('🎁 ' + tf('dailyGuest', 'きょうのおきゃくさんが「{a}」に来ているよ', { a: AREAS[daily.area].name }) +
      (daily.cont ? tf('dailyStreak', '（れんぞく {n}日目）', { n: daily.streak }) : ''), 8000);
  }
  recomputeCps();
  saveGame();

  (function addBadges() {
    var tabs = document.querySelectorAll('.sf-scene-tabs button');
    for (var i = 0; i < tabs.length; i++) {
      var b = document.createElement('span');
      b.className = 'sf-badge';
      b.hidden = true;
      tabs[i].appendChild(b);
    }
  })();

  if (window.GameAudio) {
    window.GameAudio.init('slime-farm');
    window.GameAudio.setBgm(sceneBgm(), BGM_VOLUME);
    window.GameAudio.attachMuteButton({ parent: els.stage });
  }
  els.root.addEventListener('pointerdown', unlockAudio);

  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);
  renderHud();
  renderAll();
  requestAnimationFrame(frame);
  setInterval(tick, 100);

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      saveGame();
      reportProgress();
      if (window.GameAudio) window.GameAudio.stopBgm(0.2);
    } else if (audioStarted && window.GameAudio) {
      window.GameAudio.startBgm();
    }
  });
  window.addEventListener('pagehide', function () {
    saveGame();
    reportProgress();
  });
})();
