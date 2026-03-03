/**
 * ブルアカ キャラクターソート用スクリプト (Tournament Sort Ver.)
 * - ツリー構造によるトーナメントソート
 * - 上位N位のみを決定可能（高速化）
 * - ESModules対応版
 */

import { characterData, changelogData } from './data.js';

// ------------------------------------
// セイバー（Seeded RNG）
// ------------------------------------
const RNG = {
    seed: 0,
    // シードの初期化
    init: function (s) {
        this.seed = s;
    },
    // 次の乱数を取得 (0 <= n < 1)
    next: function () {
        this.seed = (this.seed * 9301 + 49297) % 233280;
        return this.seed / 233280;
    }
};

// ------------------------------------
// SortNode クラス
// キャラクターまたはルートを表すノード
// ------------------------------------
class SortNode {
    constructor(character) {
        this.character = character; // null for root
        this.parent = null;
        this.children = [];
        this.isTie = false; // 親と引き分け（同着）かどうか

        // 途中結果のランキング精度向上のための戦績データ
        this.battles = 0;
        this.wins = 0;
        this.ties = 0;
    }

    // 自分の下のノードを全て削除する（Undo用）
    destroy() {
        this.children.forEach(child => child.destroy());
        this.children = [];
        this.parent = null;
        this.character = null;
    }

    // 子ノードを追加する
    addChild(node, isTie = false) {
        // 元の親から削除
        if (node.parent) {
            const idx = node.parent.children.indexOf(node);
            if (idx > -1) {
                node.parent.children.splice(idx, 1);
            }
        }

        // 引き分け（同着）の場合の処理
        // 敗者ノードを同着ノードの下に移動し、ツリー構造を維持する
        if (isTie) {
            const currentChildren = this.children.splice(0, this.children.length);
            currentChildren.forEach(child => {
                child.parent = node;
            });
            node.children.push(...currentChildren);
            node.isTie = true;
        }

        // 新しい親に設定
        node.parent = this;
        this.children.push(node);
    }

    // 自分の階層（順位）を取得
    getLevel() {
        if (this.parent) {
            return this.parent.getLevel() + 1;
        }
        return 0; // Root is 0
    }

    // 次に比較すべきペアを探す（再帰）
    // limitRank: これ以上の順位は計算しない（高速化用）
    getQuestion(limitRank) {
        // 指定順位以降の比較を打ち切る（高速化）
        const nextRank = this.getLevel() + 1;
        if (nextRank > limitRank) {
            return null;
        }

        // ルート直下の子が1つだけ（＝その順位の勝者が確定）の場合、さらにその下に委譲
        if (this.children.length === 1) {
            return this.children[0].getQuestion(limitRank);
        }

        // 子が2つ以上ある場合、ここから勝者を決める必要がある
        if (this.children.length >= 2) {
            // ランダムに2つ選ぶ (Seeded RNGを使用)
            const idx1 = Math.floor(RNG.next() * this.children.length);
            let idx2 = Math.floor(RNG.next() * this.children.length);
            while (idx1 === idx2) {
                idx2 = Math.floor(RNG.next() * this.children.length);
            }
            return [this.children[idx1], this.children[idx2]];
        }

        // 子が0なら比較対象なし
        return null;
    }

    // 結果表示用にリストを取得する
    // 途中経過の場合でも、戦績を元に最も精度の高い暫定ランキングを作成する
    getResultList(targetRank) {
        let result = [];

        // 1. ツリー全体のノードを全て集める
        const allNodes = [];
        const traverse = (node) => {
            if (node.character) {
                allNodes.push(node);
            }
            node.children.forEach(child => traverse(child));
        };
        // ルートから全探索（ルート自身はcharacterが無いのでスキップされる）
        traverse(this);

        // 2. 「すでに順位が確定している絶対的な鎖（Root -> child[0] -> child[0]...）」を辿る
        const lockedNodes = new Set();
        let curr = this;
        // トーナメントソートの性質上、常に勝ち続けていて子が1人のみの状態は「完全に順位が確定している」部分
        while (curr.children.length === 1) {
            curr = curr.children[0];
            if (curr.character) {
                lockedNodes.add(curr);
                result.push(curr);
            }
        }

        // 3. それ以外のノード（未確定プール）を取得
        // この時点で1度も試合をしていないキャラクターは圏外として扱う（リストに入れない）
        const undecidedNodes = allNodes.filter(n => !lockedNodes.has(n) && (n.battles || 0) > 0);

        // 4. 未確定プールをヒューリスティックなスコア（ポイント、勝率、負け数）を用いてソート
        undecidedNodes.sort((a, b) => {
            const aWins = a.wins || 0;
            const bWins = b.wins || 0;
            const aTies = a.ties || 0;
            const bTies = b.ties || 0;
            const aBattles = a.battles || 0;
            const bBattles = b.battles || 0;

            const aLosses = aBattles - aWins - aTies;
            const bLosses = bBattles - bWins - bTies;

            // ポイント: 勝ち=3点、引き分け=1点
            const aPts = (aWins * 3) + (aTies * 1);
            const bPts = (bWins * 3) + (bTies * 1);

            if (aPts !== bPts) return bPts - aPts; // ポイント順（降順）

            // 勝率
            const aRate = aBattles > 0 ? aWins / aBattles : 0;
            const bRate = bBattles > 0 ? bWins / bBattles : 0;

            if (aRate !== bRate) return bRate - aRate; // 勝率順（降順）

            // 負け数（少ない方が偉い）
            if (aLosses !== bLosses) return aLosses - bLosses; // 負け数（昇順）

            // それでも同じ場合は単純な勝数
            if (aWins !== bWins) return bWins - aWins;

            return 0; // 完全に同着
        });

        // 5. 確定済みリストの末尾に、未確定リストを結合する
        const combined = [...result, ...undecidedNodes];

        // 6. UI表示用のランク（順位）を振り直す
        const finalResult = [];
        let currentDisplayRank = 1;

        for (let i = 0; i < combined.length; i++) {
            const node = combined[i];

            // 確定済みリストの中身は問答無用でそのままの順位（i + 1）にする
            if (i < result.length) {
                currentDisplayRank = i + 1;
            } else {
                // 未確定エリアの順位付け（同着判定処理）
                if (i > 0) {
                    const prev = combined[i - 1];
                    const pWins = prev.wins || 0, cWins = node.wins || 0;
                    const pTies = prev.ties || 0, cTies = node.ties || 0;
                    const pBattles = prev.battles || 0, cBattles = node.battles || 0;
                    const pLosses = pBattles - pWins - pTies;
                    const cLosses = cBattles - cWins - cTies;
                    const pPts = (pWins * 3) + (pTies * 1);
                    const cPts = (cWins * 3) + (cTies * 1);
                    const pRate = pBattles > 0 ? pWins / pBattles : 0;
                    const cRate = cBattles > 0 ? cWins / cBattles : 0;

                    const isSameStats = (pPts === cPts && pRate === cRate && pLosses === cLosses);

                    // 前のキャラが確定済みエリアだったり、ステータスが違ったりすれば順位を＋１
                    if (i === result.length || !isSameStats) {
                        currentDisplayRank = i + 1;
                    }
                }
            }

            finalResult.push({
                character: node.character,
                rank: currentDisplayRank,
                isTie: node.isTie
            });
        }

        // 指定順位分だけを返す
        return finalResult.slice(0, targetRank);
    }

    // 自分の順位を計算（引き分け考慮）
    getRank() {
        if (this.parent) {
            // 親が同着フラグ持ちなら、親と同じ順位
            if (this.isTie) {
                return this.parent.getRank();
            }
            return this.parent.getRank() + 1;
        }
        return 0;
    }

    // ノードを削除する（除外機能用）
    // 自分の子をすべて親に委譲して、自分は消える
    remove() {
        if (!this.parent) return; // Rootは消せない（はず）

        // 除外されたキャラの子供たちを親に再接続し、再比較の対象にする
        const myChildren = this.children.splice(0, this.children.length);
        myChildren.forEach(child => {
            child.parent = this.parent;
            this.parent.children.push(child);
        });

        // 親から自分を削除
        const idx = this.parent.children.indexOf(this);
        if (idx > -1) {
            this.parent.children.splice(idx, 1);
        }
    }
}

const sortEngine = {
    // ------------------------------------
    // 状態管理変数
    rootNode: null,        // ソートツリーのルート
    currentQuestion: null, // 現在の比較ペア [nodeA, nodeB]
    currentCount: 0,       // 現在の比較回数
    targetLimit: 10,       // 何位まで決めるか

    // データ保持用
    initialList: [],       // 初期化時のキャラリスト（順番含む）
    history: [],           // 操作履歴 ['left', 'right', 'tie', 'exclude:left', ...]
    initialSeed: 0,        // RNGの初期シード
    imageCache: [],        // プリロードした画像を保持してガベージコレクションを防ぐ配列

    // 衣装のインデックス管理 [nodeAのindex, nodeBのindex]
    currentCostumeIndices: { left: 0, right: 0 },

    // ------------------------------------
    // フィルターUI初期化・操作用メソッド
    // ------------------------------------
    setupFilters: function () {
        const container = document.getElementById('hierarchical-filters');
        if (!container) return;

        // 既存のチェック状態を保存（再描画時に復元するため）
        const currentChecked = {};
        const existingCheckboxes = container.querySelectorAll('.char-chk');
        const isFirstLoad = existingCheckboxes.length === 0;
        if (!isFirstLoad) {
            existingCheckboxes.forEach(chk => {
                currentChecked[chk.value] = chk.checked;
            });
            container.innerHTML = '';
        }

        // 階層データ構造の作成 (Academy -> Club -> Characters)
        const hierarchy = {};
        characterData.forEach(char => {
            const acad = char.academy || "その他";
            const club = char.club || "無所属";
            if (!hierarchy[acad]) hierarchy[acad] = {};
            if (!hierarchy[acad][club]) hierarchy[acad][club] = [];
            hierarchy[acad][club].push(char);
        });

        // 学園の読みがな（あいうえお順用）
        const getAcadYomi = (acad) => {
            const map = {
                "アビドス高等学校": "あびどす",
                "アリウス分校": "ありうす",
                "ヴァルキューレ警察学校": "う゛ぁるきゅーれ",
                "オデッセイ海洋学園": "おでっせい",
                "ゲヘナ学園": "げへな",
                "クロノスハイスクール": "くろのす",
                "山海経高級中学校": "さんかいきょう",
                "SRT特殊学園": "えすあーるてぃー",
                "トリニティ総合学園": "とりにてぃ",
                "ハイランダー鉄道学園": "はいらんだー",
                "百鬼夜行連合学院": "ひゃっきやこう",
                "ミレニアムサイエンススクール": "みれにあむ",
                "レッドウィンター連邦学園": "れっどうぃんたー",
                "ワイルドハント芸術学園": "わいるどはんと",
                "コラボ": "んん_こらぼ",
                "その他": "んん_そのた"
            };
            return map[acad] || acad;
        };

        const acadCount = {};
        const clubCount = {};

        for (const acad in hierarchy) {
            let acadTotal = 0;
            clubCount[acad] = {};
            for (const club in hierarchy[acad]) {
                let clubTotal = hierarchy[acad][club].length;
                clubCount[acad][club] = clubTotal;
                acadTotal += clubTotal;

                // キャラクター自身の並び順も「日本語の名前順」に整える
                hierarchy[acad][club].sort((a, b) => a.name.localeCompare(b.name, 'ja'));
            }
            acadCount[acad] = acadTotal;
        }

        const sortModeEl = document.getElementById('opt-list-sort');
        const sortMode = sortModeEl ? sortModeEl.value : 'name_asc';

        let sortedAcademies = Object.keys(hierarchy);
        if (sortMode === 'name_asc') {
            sortedAcademies.sort((a, b) => getAcadYomi(a).localeCompare(getAcadYomi(b), 'ja'));
        } else if (sortMode === 'name_desc') {
            sortedAcademies.sort((a, b) => getAcadYomi(b).localeCompare(getAcadYomi(a), 'ja'));
        } else if (sortMode === 'count_desc') {
            sortedAcademies.sort((a, b) => acadCount[b] - acadCount[a] || getAcadYomi(a).localeCompare(getAcadYomi(b), 'ja'));
        } else if (sortMode === 'count_asc') {
            sortedAcademies.sort((a, b) => acadCount[a] - acadCount[b] || getAcadYomi(a).localeCompare(getAcadYomi(b), 'ja'));
        }

        // HTML生成
        for (const acad of sortedAcademies) {
            const acadDiv = document.createElement('div');
            acadDiv.className = 'filter-academy-group'; // 最初はすべて開かれた状態
            acadDiv.innerHTML = `
                <div class="filter-academy-header">
                    <button type="button" class="toggle-collapse-btn">▼</button>
                    <label class="custom-checkbox"><input type="checkbox" class="acad-chk" checked><span class="checkmark"></span><strong style="margin-left:5px;">${acad}</strong></label>
                </div>
            `;
            const acadContent = document.createElement('div');
            acadContent.className = 'filter-academy-content';

            let sortedClubs = Object.keys(hierarchy[acad]);
            if (sortMode === 'name_asc') {
                sortedClubs.sort((a, b) => a.localeCompare(b, 'ja'));
            } else if (sortMode === 'name_desc') {
                sortedClubs.sort((a, b) => b.localeCompare(a, 'ja'));
            } else if (sortMode === 'count_desc') {
                sortedClubs.sort((a, b) => clubCount[acad][b] - clubCount[acad][a] || a.localeCompare(b, 'ja'));
            } else if (sortMode === 'count_asc') {
                sortedClubs.sort((a, b) => clubCount[acad][a] - clubCount[acad][b] || a.localeCompare(b, 'ja'));
            }

            for (const club of sortedClubs) {
                const clubDiv = document.createElement('div');
                clubDiv.className = 'filter-club-group'; // 最初はすべて開かれた状態
                clubDiv.innerHTML = `
                    <div class="filter-club-header">
                        <label class="custom-checkbox"><input type="checkbox" class="club-chk" checked><span class="checkmark"></span><span style="margin-left:5px;">${club}</span></label>
                        <button type="button" class="toggle-collapse-btn">▼</button>
                    </div>
                `;
                const charGrid = document.createElement('div');
                charGrid.className = 'char-grid';

                hierarchy[acad][club].forEach(char => {
                    const lbl = document.createElement('label');
                    lbl.title = char.name;
                    lbl.classList.add('char-lbl', 'custom-checkbox');
                    lbl.setAttribute('data-name', char.name);
                    lbl.setAttribute('data-folder', char.folder);

                    const isChecked = isFirstLoad ? true : !!currentChecked[char.id];
                    lbl.innerHTML = `<input type="checkbox" value="${char.id}" class="filter-chk char-chk" ${isChecked ? 'checked' : ''}><span class="checkmark"></span><span class="char-name-text" style="margin-left:5px;">${char.name}</span>`;
                    charGrid.appendChild(lbl);
                });

                clubDiv.appendChild(charGrid);
                acadContent.appendChild(clubDiv);
            }
            acadDiv.appendChild(acadContent);
            container.appendChild(acadDiv);
        }

        // --- イベントリスナーの登録 ---
        // チェックボックスの状態変更イベント（change）
        container.addEventListener('change', (e) => {
            const target = e.target;
            if (target.classList.contains('acad-chk')) {
                // 学園のチェック変更：配下の全チェックボックスを連動させる
                const acadGroup = target.closest('.filter-academy-group');
                const checkboxes = acadGroup.querySelectorAll('input[type="checkbox"]:not(:disabled)');
                checkboxes.forEach(chk => chk.checked = target.checked);
            } else if (target.classList.contains('club-chk')) {
                // 部活のチェック変更：配下のキャラを連動させ、学園の状態を更新
                const clubGroup = target.closest('.filter-club-group');
                const checkboxes = clubGroup.querySelectorAll('.char-chk:not(:disabled)');
                checkboxes.forEach(chk => chk.checked = target.checked);

                const acadGroup = target.closest('.filter-academy-group');
                this.updateParentCheckboxState(acadGroup);
            } else if (target.classList.contains('char-chk')) {
                // キャラのチェック変更：親の部活・学園の状態を更新
                const acadGroup = target.closest('.filter-academy-group');
                const clubGroup = target.closest('.filter-club-group');
                this.updateParentCheckboxState(acadGroup, clubGroup);
            }
            this.updateFilterCounts();
        });

        // アコーディオンの開閉トグルボタン用のクリックイベント（click）
        container.addEventListener('click', (e) => {
            const target = e.target;
            if (target.classList.contains('toggle-collapse-btn')) {
                const acadGroup = target.closest('.filter-academy-group');
                const clubGroup = target.closest('.filter-club-group');
                if (target.parentElement.classList.contains('filter-club-header')) {
                    clubGroup.classList.toggle('is-collapsed');
                } else if (target.parentElement.classList.contains('filter-academy-header')) {
                    acadGroup.classList.toggle('is-collapsed');
                }
            }
        });

        // --- 右クリックによる横スクロール機能 ---
        let isDown = false;
        let startX;
        let scrollLeft;

        container.addEventListener('mousedown', (e) => {
            if (e.button !== 2) return; // 右クリックのみ対象
            isDown = true;
            container.classList.add('active'); // CSSでカーソル変更などに使える
            startX = e.pageX - container.offsetLeft;
            scrollLeft = container.scrollLeft;
        });

        container.addEventListener('mouseleave', () => {
            isDown = false;
            container.classList.remove('active');
        });

        container.addEventListener('mouseup', (e) => {
            if (e.button === 2) {
                isDown = false;
                container.classList.remove('active');
            }
        });

        container.addEventListener('mousemove', (e) => {
            if (!isDown) return;
            e.preventDefault();
            const x = e.pageX - container.offsetLeft;
            const walk = (x - startX) * 2; // スクロール速度の倍率
            container.scrollLeft = scrollLeft - walk;
        });

        // コンテナ内部での右クリックメニュー（コンテキストメニュー）を抑制
        container.addEventListener('contextmenu', (e) => {
            e.preventDefault();
        });

        // フォルダ系のチェックボックス（実装済み等）の変更イベント監視
        ['opt-released', 'opt-npc', 'opt-collab'].forEach(id => {
            const el = document.getElementById(id);
            if (el) {
                el.addEventListener('change', () => {
                    this.updateFolderDisabledState(null);
                    this.updateFilterCounts();
                });
            }
        });

        // 初期状態は全ての previousCheckedState を「checked (true)」として記録しておく
        document.querySelectorAll('.char-chk').forEach(chk => {
            chk.dataset.previousCheckedState = 'true';
        });

        // 初期のグレーアウト状態を適用
        this.updateFolderDisabledState();
        this.updateFilterCounts();
    },

    // 子のチェック状態に応じて、親（学園・部活）のチェック状態を自動更新
    updateParentCheckboxState: function (acadGroup, clubGroup = null) {
        if (clubGroup) {
            const clubBox = clubGroup.querySelector('.club-chk');
            const allEnabledChars = clubGroup.querySelectorAll('.char-chk:not(:disabled)');
            if (allEnabledChars.length > 0) {
                clubBox.checked = Array.from(allEnabledChars).some(c => c.checked);
            }
        }
        if (acadGroup) {
            const acadBox = acadGroup.querySelector('.acad-chk');
            const allEnabledClubs = acadGroup.querySelectorAll('.club-chk:not(:disabled)');
            if (allEnabledClubs.length > 0) {
                acadBox.checked = Array.from(allEnabledClubs).some(c => c.checked);
            }
        }
    },

    // 「すべてON / OFF」ボタンの処理
    toggleAllFilters: function (state) {
        const checkboxes = document.querySelectorAll('#hierarchical-filters input[type="checkbox"]:not(:disabled)');
        checkboxes.forEach(chk => chk.checked = state);
        this.updateFilterCounts();
    },

    // 検索窓の処理
    filterCharList: function () {
        const input = document.getElementById('char-search-input').value.toLowerCase();

        const acadGroups = document.querySelectorAll('.filter-academy-group');
        acadGroups.forEach(acad => {
            let acadHasVisibleChar = false;

            const clubGroups = acad.querySelectorAll('.filter-club-group');
            clubGroups.forEach(club => {
                let clubHasVisibleChar = false;

                const labels = club.querySelectorAll('.char-lbl');
                labels.forEach(lbl => {
                    const name = lbl.getAttribute('data-name').toLowerCase();
                    if (name.includes(input)) {
                        lbl.style.display = '';
                        clubHasVisibleChar = true;
                        acadHasVisibleChar = true;
                    } else {
                        lbl.style.display = 'none';
                    }
                });

                // 部活内に表示できるキャラが1人もいない場合は部活丸ごと隠す
                club.style.display = clubHasVisibleChar ? '' : 'none';
            });

            // 学園内に表示できる部活(キャラ)が1つもない場合は学園丸ごと隠す
            acad.style.display = acadHasVisibleChar ? '' : 'none';
        });
    },

    // 大ジャンル（実装済み、NPCなど）のON/OFFに応じて、対象外のキャラをグレーアウトする
    updateFolderDisabledState: function (e = null) {
        const useReleased = document.getElementById('opt-released').checked;
        const useNPC = document.getElementById('opt-npc').checked;
        const useCollab = document.getElementById('opt-collab').checked;

        const labels = document.querySelectorAll('.char-lbl');
        labels.forEach(lbl => {
            const folder = lbl.getAttribute('data-folder');
            const chk = lbl.querySelector('.char-chk');
            let isEnabled = false;

            if (folder === 'RELEASED' && useReleased) isEnabled = true;
            if (folder === 'NPC' && useNPC) isEnabled = true;
            if (folder === 'COLLAB' && useCollab) isEnabled = true;

            // 状態が変化する瞬間の処理
            if (chk.disabled !== !isEnabled) {
                if (isEnabled) {
                    // グレーアウトから復帰する時：無効になる直前のチェック状態を復元する
                    const prevState = chk.dataset.previousCheckedState === 'true';
                    chk.checked = prevState;
                    chk.disabled = false;
                    lbl.classList.remove('disabled-label');
                } else {
                    // グレーアウトする時：現在の状態を保存してからチェックを外す
                    chk.dataset.previousCheckedState = chk.checked ? 'true' : 'false';
                    chk.checked = false;
                    chk.disabled = true;
                    lbl.classList.add('disabled-label');
                }
            } else {
                // ユーザーが手動でチェックを外した時は、最新の状態をpreviousとして保存しておく（無効化されていない間常に）
                if (isEnabled) {
                    chk.dataset.previousCheckedState = chk.checked ? 'true' : 'false';
                }
            }
        });

        // グレーアウト変更後に親のチェックボックス状態を再計算
        const acadGroups = document.querySelectorAll('.filter-academy-group');
        acadGroups.forEach(acadGroup => {
            const clubGroups = acadGroup.querySelectorAll('.filter-club-group');
            clubGroups.forEach(clubGroup => {
                this.updateParentCheckboxState(acadGroup, clubGroup);
            });
        });
    },

    // カウントバッジの更新
    updateFilterCounts: function () {
        const chBadge = document.getElementById('char-count-badge');
        if (chBadge) {
            const chCount = document.querySelectorAll('.char-chk:checked:not(:disabled)').length;
            const chTotal = document.querySelectorAll('.char-chk:not(:disabled)').length;
            chBadge.textContent = `${chCount}/${chTotal}`;
        }
    },

    // ------------------------------------
    // 1. 初期化処理
    // ------------------------------------
    init: function () {
        // オプション（チェックボックス）の状態を取得
        const useReleased = document.getElementById('opt-released').checked;
        const useNPC = document.getElementById('opt-npc').checked;
        const useCollab = document.getElementById('opt-collab').checked;

        // 詳細フィルター（個別キャラ）の状態を取得
        // （グレーアウト＝disabledされていない、かつチェックされているキャラのみ対象とする）
        const checkedCharIds = Array.from(document.querySelectorAll('.char-chk:checked:not(:disabled)')).map(chk => chk.value);

        // data.js の characterData から対象を抽出
        const list = characterData.filter(char => {
            // 個別キャラクター指定のチェックに含まれているキャラのみ残す
            // (大枠のフォルダ条件も、グレーアウト機構によってdisabledが制御され、チェックが外れているので条件は満たせる)
            if (document.querySelector('.char-chk') && !checkedCharIds.includes(char.id)) {
                return false;
            }
            return true;
        });

        // 2人未満なら開始できない
        if (list.length < 2) {
            alert("キャラクターが2人以上選択されていません。");
            return;
        }

        // シャッフル (Fisher-Yates)
        // ここで順序を確定させ、initialListとして保存しておく
        for (let i = list.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [list[i], list[j]] = [list[j], list[i]];
        }
        this.initialList = [...list]; // コピー保存

        // ランク指定を取得
        const limitVal = document.getElementById('opt-rank-count').value;
        this.targetLimit = parseInt(limitVal) || 10;

        // 履歴リセット
        this.history = [];

        // RNGシード初期化と保存
        this.initialSeed = Date.now();
        RNG.init(this.initialSeed);

        // ツリー構築と開始
        this.buildTree();

        // 画面切り替え
        document.getElementById('start-view').classList.add('hidden');
        document.getElementById('battle-view').classList.remove('hidden');

        // バトルモード用クラス追加（中央寄せ）
        document.body.classList.add('battle-mode');

        this.startBattle();
    },

    // ツリーの再構築（Undo用）
    buildTree: function () {
        // RNGを初期シードにリセット（これでUndo時の再現性が保たれる）
        RNG.init(this.initialSeed);

        // 既存ツリーの破棄（必要なら）
        if (this.rootNode) this.rootNode.destroy();

        this.rootNode = new SortNode(null); // Root
        this.currentCount = 0;

        // 保存しておいたリスト順序で再追加
        this.initialList.forEach(char => {
            const node = new SortNode(char);
            this.rootNode.addChild(node);
        });
    },

    // ------------------------------------
    // 2. ソートロジック
    // ------------------------------------
    startBattle: function () {
        this.ask();
    },

    // ユーザーに質問を提示する
    ask: function () {
        // Rootから探索して、比較が必要なペアを取得
        const pair = this.rootNode.getQuestion(this.targetLimit);

        if (!pair) {
            // 比較すべきペアがいなくなった ＝ ソート完了（または指定順位まで確定）
            this.showResult();
            return;
        }

        this.currentQuestion = pair;
        const [nodeA, nodeB] = pair;

        // まず最初に、決定したペアの画像をプリロード（バックグラウンド読込）開始する
        this.preloadNext();

        // 続けて画面表示を更新（ここで画像のsrcが切り替わる）
        this.updateFighterView(nodeA.character, nodeB.character);
    },

    preloadNext: function () {
        if (!this.currentQuestion) return;
        const [nodeA, nodeB] = this.currentQuestion;

        // 現在表示されるキャラの全衣装を即座にプリロード開始（遅延なし）
        this.preloadCharacterImages(nodeA.character);
        this.preloadCharacterImages(nodeB.character);
    },

    // 一度プリロードした画像のURLを記録するSet
    preloadedUrls: new Set(),
    preloadContainer: null,

    // デバッグログ出力用関数
    addDebugLog: function (message) {
        const debugLog = document.getElementById('debug-log');
        if (!debugLog) return;

        // タイムスタンプ作成 (HH:MM:SS.mmm)
        const now = new Date();
        const timestamp = `[${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}.${now.getMilliseconds().toString().padStart(3, '0')}]`;

        const p = document.createElement('p');
        p.innerText = `${message}${timestamp}`;
        debugLog.appendChild(p);

        // 常に一番下へスクロール
        debugLog.scrollTop = debugLog.scrollHeight;
    },

    // 指定されたキャラターの全衣装画像をプリロードする
    preloadCharacterImages: function (char) {
        if (!char || !char.images) return;

        if (!this.preloadContainer) {
            this.preloadContainer = document.createElement('div');
            this.preloadContainer.style.display = 'none';
            document.body.appendChild(this.preloadContainer);
        }

        char.images.forEach(imgData => {
            const url = `src/img/${char.folder}/${imgData.file}`;

            // 既にプリロード済みの場合はスキップ
            if (this.preloadedUrls.has(url)) return;
            this.preloadedUrls.add(url);

            this.addDebugLog(`プリロード (${char.name} - ${imgData.label})`);

            // 隠し <img> タグを生成してDOMに挿入（ブラウザに強制ダウンロード＆キャッシュ保持させる）
            const img = new Image();
            img.src = url;
            this.preloadContainer.appendChild(img);
        });
    },

    // ユーザーの選択処理
    // choice: 'left' | 'right' | 'tie'
    // isReplay: Undo時の再実行中はtrue
    select: function (choice, isReplay = false) {
        if (!this.currentQuestion) return;

        // 進行中のアニメーションがあれば二重クリックを防止
        if (this.isAnimating && !isReplay) return;

        const [leftNode, rightNode] = this.currentQuestion;

        if (!isReplay) {
            let clickedName = '';
            if (choice === 'left') clickedName = leftNode.character.name;
            else if (choice === 'right') clickedName = rightNode.character.name;
            else clickedName = '引き分け';
            this.addDebugLog(`${clickedName}が押された`);
        }

        // 履歴に追加（再実行中でなければ）
        if (!isReplay) {
            this.history.push({ type: 'select', value: choice });
        }

        // ★ 暫定ランキング精度のための戦績記録
        leftNode.battles++;
        rightNode.battles++;
        // getResultList用の一時アクセス参照をキャラにもたせる（ハック的だが簡単）
        leftNode.character.__nodeRef = leftNode;
        rightNode.character.__nodeRef = rightNode;

        if (choice === 'left') {
            // 左の勝ち：右を左の子にする
            leftNode.wins++;
            leftNode.addChild(rightNode);
        } else if (choice === 'right') {
            // 右の勝ち：左を右の子にする
            rightNode.wins++;
            rightNode.addChild(leftNode);
        } else {
            // 引き分け (スキップ)
            leftNode.ties++;
            rightNode.ties++;
            leftNode.addChild(rightNode, true);
        }

        // 進捗更新
        this.currentCount++;

        // 再実行中はアニメーションや表示更新をしない（一括で最後にする）
        if (isReplay) {
            return;
        }

        // --- ロード＆アニメーション処理 ---
        this.isAnimating = true;

        // 次の質問を予測して「プリロードだけ」を先に開始する（DOMはまだ書き換えない）
        const savedSeed = RNG.seed;
        const nextPair = this.rootNode.getQuestion(this.targetLimit);
        RNG.seed = savedSeed; // 乱数の状態を元に戻す

        if (nextPair) {
            // アニメーションしている時間を使ってバックグラウンドで読み込む
            this.preloadCharacterImages(nextPair[0].character);
            this.preloadCharacterImages(nextPair[1].character);
        }

        this.addDebugLog(`アニメーションを再生`);

        const leftImg = document.getElementById('left-img');
        const rightImg = document.getElementById('right-img');

        // ★改善案2: クリックされた時の「押し込み（プッシュ）」エフェクト
        if (choice === 'left' && leftImg) leftImg.classList.add('card-push');
        if (choice === 'right' && rightImg) rightImg.classList.add('card-push');

        // プッシュエフェクトが終わるまで（100ms程）待ってから退場（Leave）アニメーションへ
        setTimeout(() => {
            // プッシュ状態を解除
            if (leftImg) leftImg.classList.remove('card-push');
            if (rightImg) rightImg.classList.remove('card-push');

            // ★改善案4: 勝者・敗者の退場アニメーションを付与
            if (choice === 'left') {
                if (leftImg) leftImg.classList.add('card-leave-winner');
                if (rightImg) rightImg.classList.add('card-leave-loser');
            } else if (choice === 'right') {
                if (leftImg) leftImg.classList.add('card-leave-loser');
                if (rightImg) rightImg.classList.add('card-leave-winner');
            } else {
                // 引き分け時は仲良く下に消える
                if (leftImg) leftImg.classList.add('card-leave-tie');
                if (rightImg) rightImg.classList.add('card-leave-tie');
            }

            // 退場アニメーション完了（約0.3秒）を待ってから、画面を書き換える
            setTimeout(() => {
                // 退場状態（透明度0）を維持しているクラスを解除
                if (leftImg) leftImg.classList.remove('card-leave-winner', 'card-leave-loser', 'card-leave-tie');
                if (rightImg) rightImg.classList.remove('card-leave-winner', 'card-leave-loser', 'card-leave-tie');

                // ここで本番の次のペア選定が行われ、DOMの中身（名前・画像など）が書き換わる
                this.updateProgress();
                this.ask();

                // 新しく描画された画像要素を取得
                const newLeftImg = document.getElementById('left-img');
                const newRightImg = document.getElementById('right-img');

                // 新しい画像に「スライドインの準備状態（画面外・透明度0）」のクラスを直付けする
                if (choice === 'left') {
                    if (newLeftImg) newLeftImg.classList.add('card-slide-in-prepare-left');
                    if (newRightImg) newRightImg.classList.add('card-slide-in-prepare-right');
                } else if (choice === 'right') {
                    if (newLeftImg) newLeftImg.classList.add('card-slide-in-prepare-left');
                    if (newRightImg) newRightImg.classList.add('card-slide-in-prepare-right');
                } else {
                    if (newLeftImg) newLeftImg.classList.add('card-slide-in-prepare-bottom');
                    if (newRightImg) newRightImg.classList.add('card-slide-in-prepare-bottom');
                }

                // ブラウザに一度準備状態を認識させた後、クラスを剥がしてスライドイン（現れる）させる
                requestAnimationFrame(() => {
                    requestAnimationFrame(() => {
                        // クラスを剥がすと、改善案1の「弾むようなイージング」に乗って定位置へ戻る
                        if (newLeftImg) newLeftImg.classList.remove('card-slide-in-prepare-left', 'card-slide-in-prepare-bottom');
                        if (newRightImg) newRightImg.classList.remove('card-slide-in-prepare-right', 'card-slide-in-prepare-bottom');

                        // スライドイン完了（約0.4秒）後にロック解除
                        setTimeout(() => {
                            this.isAnimating = false;
                        }, 400); // 新しいイージングの時間(0.4s)に合わせる
                    });
                });
            }, 300); // .card-leave-* の transition 時間 (0.3s) に合わせる
        }, 150); // .card-push の transition 時間 (0.1s + 少しの余韻) に合わせる
    },

    // スキップ処理 (Tieと同じ扱いだが、UI上の意味合いが違う)
    skip: function () {
        this.select('tie');
    },

    // 一つ戻る (Undo)
    undo: function () {
        if (this.history.length === 0) {
            alert("これ以上戻れません。");
            return;
        }

        // 最後の操作を取り除く
        this.history.pop();

        // 最初から再実行するためにツリーをリセット
        this.buildTree();

        // 履歴の内容を最初から順に適用（状態の再現）
        try {
            // 初回の質問をセット
            const firstPair = this.rootNode.getQuestion(this.targetLimit);
            if (firstPair) {
                this.currentQuestion = firstPair;
            } else {
                console.error("Undo error: No initial question found.");
                return;
            }

            for (const action of this.history) {
                // ここで ask() して質問を取得済みである前提
                if (action.type === 'select') {
                    this.select(action.value, true);
                    const nextPair = this.rootNode.getQuestion(this.targetLimit);
                    if (nextPair) {
                        this.currentQuestion = nextPair;
                    }
                } else if (action.type === 'exclude') {
                    this.exclude(action.value, true);

                    const nextPair = this.rootNode.getQuestion(this.targetLimit);
                    if (nextPair) {
                        this.currentQuestion = nextPair;
                    }
                }
            }

            // 再生完了。現在の状態をUIに反映
            this.updateProgress();

            // 最後の質問を表示（askの後半と同じ処理）
            if (this.currentQuestion) {
                const [nodeA, nodeB] = this.currentQuestion;
                this.updateFighterView(nodeA.character, nodeB.character);
            }

        } catch (e) {
            console.error("Undo failed:", e);
            alert("Undo中にエラーが発生しました。リセットします。");
            this.init();
        }
    },

    // 除外処理
    // side: 'left' | 'right' | 'both'
    exclude: function (side, isReplay = false) {
        if (!this.currentQuestion) return;

        // 履歴追加
        if (!isReplay) {
            this.history.push({ type: 'exclude', value: side });
        }

        const [leftNode, rightNode] = this.currentQuestion;

        if (side === 'left') {
            leftNode.remove();
        } else if (side === 'right') {
            rightNode.remove();
        } else if (side === 'both') {
            leftNode.remove();
            rightNode.remove();
        }

        // 比較対象が消えた
        this.currentQuestion = null;

        if (!isReplay) {
            this.ask();
        }
    },

    // 衣装切り替え（タブから直接選択）
    changeCostumeDirect: function (side, index) {
        if (!this.currentQuestion) return;

        const [leftNode, rightNode] = this.currentQuestion;
        const char = (side === 'left') ? leftNode.character : rightNode.character;

        // 保存
        this.currentCostumeIndices[side] = index;

        // 画面更新
        this.updateCostumeView(side, char, index);
    },

    // 衣装表示の更新（画像とタブのアクティブ状態）
    updateCostumeView: function (side, char, costumeIndex) {
        const imgEl = document.getElementById(`${side}-img`);
        if (!imgEl) return;

        // 指定された衣装の情報を取得
        const costumeData = char.images[costumeIndex];
        const folderPath = `src/img/${char.folder}/`;

        // 画像の切り替え
        imgEl.src = folderPath + costumeData.file;

        // クロップ位置（中心ズレ）の適用：offsetX（％）が存在すれば中心50％から足し引きする
        const offsetX = costumeData.offsetX || 0;
        // 50%が中央。プラスなら右へ、マイナスなら左へずれる
        imgEl.style.objectPosition = `calc(50% + ${offsetX * 4}%) top`;

        // タブのアクティブ状態更新
        const tabsEl = document.getElementById(`${side}-costume-tabs`);
        if (tabsEl) {
            const btns = tabsEl.querySelectorAll('.tab-btn');
            btns.forEach((btn, idx) => {
                if (idx === costumeIndex) {
                    btn.classList.add('active');
                } else {
                    btn.classList.remove('active');
                }
            });
        }
    },

    // ------------------------------------
    // 3. 表示関連（UI）
    // ------------------------------------

    // 左右のキャラクターを表示するメイン関数
    updateFighterView: function (charA, charB) {
        // 名前表示
        document.getElementById('left-name').innerText = charA.name;
        document.getElementById('right-name').innerText = charB.name;

        // デバッグログ出力
        this.addDebugLog(`${charA.name}が表示されました`);
        this.addDebugLog(`${charB.name}が表示されました`);

        // インデックスをリセット
        this.currentCostumeIndices = { left: 0, right: 0 };

        // 画像とUIの生成処理を呼び出し
        this.renderCharacterUI('left', charA);
        this.renderCharacterUI('right', charB);
    },

    // キャラクターごとの画像・UI初期化
    renderCharacterUI: function (side, char) {
        const tabsEl = document.getElementById(`${side}-costume-tabs`);

        // タブの生成
        if (tabsEl) {
            tabsEl.innerHTML = ''; // リセット

            // --- コンテナ全体のクリック誤爆防止（隙間などをクリックした時に次に進まないように） ---
            tabsEl.onclick = function (e) {
                e.stopPropagation();
            };

            // --- マウスホイールでの横スクロールイベントを追加 ---
            tabsEl.onwheel = function (e) {
                if (e.deltaY !== 0) {
                    e.preventDefault();
                    this.scrollLeft += (e.deltaY * 0.5); // スクロール量の調整
                }
            };

            // 衣装が1つの場合でも隠さずに全て表示する
            tabsEl.style.visibility = 'visible';
            char.images.forEach((imgData, index) => {
                const btn = document.createElement('button');
                btn.className = 'tab-btn';
                btn.innerText = imgData.label;
                btn.onclick = (e) => {
                    e.stopPropagation();
                    // 既に選択中のタブなら何もしない（誤作動防止）
                    if (this.currentCostumeIndices[side] === index) {
                        return;
                    }
                    this.changeCostumeDirect(side, index);
                };
                tabsEl.appendChild(btn);
            });
        }

        // 初期表示更新（0番目のタブのアクティブ化も含む）
        this.updateCostumeView(side, char, 0);
    },

    // 進捗状況の更新
    updateProgress: function () {
        // 現在の比較数
        document.getElementById('battle-num').innerText = this.currentCount;

        // 確定済みの順位を計算して表示
        // ルートから順番に子供が1人しかいない（＝勝者確定）階層を数える
        let determinedCount = 0;
        let diffNode = this.rootNode;

        while (diffNode.children.length === 1) {
            determinedCount++;
            diffNode = diffNode.children[0];
        }

        // 表示を更新
        // 「現在 X 位まで確定」
        const infoEl = document.getElementById('determined-rank-info');
        if (infoEl) {
            infoEl.innerText = `現在 ${determinedCount} 位まで確定`;
        }
    },

    // ------------------------------------
    // 4. 結果表示
    // ------------------------------------
    showResult: function () {
        // バトル画面を隠してリザルト画面を表示
        document.getElementById('battle-view').classList.add('hidden');
        document.getElementById('result-view').classList.remove('hidden');

        // バトルモード解除（中央寄せ解除）
        document.body.classList.remove('battle-mode');

        const container = document.getElementById('result-list');

        // 結果リストを取得
        const resultList = this.rootNode.getResultList(this.targetLimit);

        // セクション用HTML変数
        let htmlTop3 = '<div class="result-tier-section top-tier"><h3>👑 TOP 3 👑</h3><div class="result-grid">';
        let htmlTop10 = '<div class="result-tier-section mid-tier"><h3>🏆 4位 〜 10位</h3><div class="result-grid">';
        let htmlOthers = '<div class="result-tier-section low-tier"><h3>✨ 11位以下</h3><div class="result-grid">';

        let hasTop3 = false;
        let hasTop10 = false;
        let hasOthers = false;

        resultList.forEach((item) => {
            const char = item.character;
            const rank = item.rank;
            const costumeData = char.images[0]; // リザルトでは常に最初の衣装を使用
            const imgPath = `src/img/${char.folder}/${costumeData.file}`;
            const offsetX = costumeData.offsetX || 0;

            // バッジのクラス決定
            let badgeClass = 'rank-badge';
            if (rank === 1) badgeClass += ' rank-1';
            else if (rank === 2) badgeClass += ' rank-2';
            else if (rank === 3) badgeClass += ' rank-3';
            else badgeClass += ' rank-other';

            const cardStr = `
            <div class="result-card">
                <div class="${badgeClass}">${rank}</div>
                <div class="result-img-wrapper">
                    <img src="${imgPath}" alt="${char.name}" style="object-position: calc(50% + ${offsetX * 4}%) top;">
                </div>
                <div class="result-name">${char.name}</div>
            </div>`;

            // 所属セクションに割り振り
            if (rank <= 3) {
                htmlTop3 += cardStr;
                hasTop3 = true;
            } else if (rank <= 10) {
                htmlTop10 += cardStr;
                hasTop10 = true;
            } else {
                htmlOthers += cardStr;
                hasOthers = true;
            }
        });

        htmlTop3 += '</div></div>';
        htmlTop10 += '</div></div>';
        htmlOthers += '</div></div>';

        // 存在するセクションだけ出力
        let finalHtml = '';
        if (hasTop3) finalHtml += htmlTop3;
        if (hasTop10) finalHtml += htmlTop10;
        if (hasOthers) finalHtml += htmlOthers;

        container.innerHTML = finalHtml;

        // 終了後のタイトル変更などが必要ならここで行う
    },

    // X (Twitter) で結果をシェアする機能
    shareResult: function () {
        // 結果リストを取得
        const resultList = this.rootNode.getResultList(this.targetLimit);

        let shareText = "ブルーアーカイブ キャラクターソート結果✨\n\n";

        // 上位3人の名前を抽出
        const top3 = resultList.filter(item => item.rank <= 3).map(item => `${item.rank}位: ${item.character.name}`);

        if (top3.length > 0) {
            shareText += top3.join("\n") + "\n\n";
        }

        shareText += "#ブルアカ #キャラクターソート\n\n";

        // 現在のURL（GitHub PagesなどのURLになる想定）を取得
        // ※ローカルファイル実行時は file://... になるため環境次第で置き換わる
        const currentUrl = window.location.href;

        // X (Twitter) の Web Intent URL を生成
        const twitterIntentUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(shareText)}&url=${encodeURIComponent(currentUrl)}`;

        // 別タブで開く
        window.open(twitterIntentUrl, "_blank");
    },

    // ------------------------------------
    // 5. モーダル（拡大）表示機能
    // ------------------------------------
    currentModalSide: null, // モーダルのスワイプ用に保持

    openModal: function (side, event) {
        event.stopPropagation(); // ソートのクリック判定をストップ
        this.currentModalSide = side;

        const nodes = this.currentQuestion;
        if (!nodes) return;

        const char = (side === 'left') ? nodes[0].character : nodes[1].character;
        if (!char) return;

        const currentIndex = this.currentCostumeIndices[side] || 0;
        const costumeData = char.images[currentIndex];

        const modal = document.getElementById('image-modal');
        const modalImg = document.getElementById('modal-img');
        // swipeHintの変数取得は削除（下部で取得するため）

        // 画像セット
        modalImg.src = `src/img/${char.folder}/${costumeData.file}`;

        // クロップ中心位置セット（offsetX）
        const offsetX = costumeData.offsetX || 0;
        modalImg.style.objectPosition = `calc(50% + ${offsetX * 4}%) top`;

        // アニメーション用にクラスをリセットして再付与
        modalImg.classList.remove('swipe-animate-left', 'swipe-animate-right');
        void modalImg.offsetWidth;

        modal.classList.remove('hidden');

        // 衣装が複数ある場合はスワイプヒントを表示
        const swipeHint = document.getElementById('swipe-hint');
        if (swipeHint) {
            if (char.images.length > 1) {
                swipeHint.classList.remove('hidden');
            } else {
                swipeHint.classList.add('hidden');
            }
        }
    },

    closeModal: function () {
        this.currentModalSide = null;
        const modal = document.getElementById('image-modal');
        modal.classList.add('hidden');
    }
};

// --- スマホ用スワイプイベント（モーダル内での衣装切り替え） ---
let modalTouchStartX = 0;
let modalTouchEndX = 0;

function initModalSwipe() {
    const modalEl = document.getElementById('image-modal');
    if (!modalEl) return;

    modalEl.addEventListener('touchstart', (e) => {
        modalTouchStartX = e.changedTouches[0].screenX;
    });

    modalEl.addEventListener('touchend', (e) => {
        modalTouchEndX = e.changedTouches[0].screenX;
        handleModalSwipe();
    });

    function handleModalSwipe() {
        const threshold = 50; // スワイプと判定する移動距離(px)
        const side = sortEngine.currentModalSide;
        if (!side) return; // モーダルが開いてないか対象外なら無視

        const nodes = sortEngine.currentQuestion;
        if (!nodes) return;

        const char = (side === 'left') ? nodes[0].character : nodes[1].character;
        if (!char || char.images.length <= 1) return; // 衣装が1つだけなら無効

        let currentIndex = sortEngine.currentCostumeIndices[side] || 0;
        const maxIndex = char.images.length - 1;

        if (modalTouchEndX < modalTouchStartX - threshold) {
            // 左にスワイプ（次へ）
            if (currentIndex < maxIndex) {
                sortEngine.changeCostumeDirect(side, currentIndex + 1);
                const modalImg = document.getElementById('modal-img');
                const costumeData = char.images[currentIndex + 1];
                modalImg.src = `src/img/${char.folder}/${costumeData.file}`;

                // クロップ位置適用
                const offsetX = costumeData.offsetX || 0;
                modalImg.style.objectPosition = `calc(50% + ${offsetX * 4}%) top`;

                // アニメーションを再トリガー
                modalImg.classList.remove('swipe-animate-left', 'swipe-animate-right');
                void modalImg.offsetWidth; // リフロー強制
                modalImg.classList.add('swipe-animate-left');
            }
        } else if (modalTouchEndX > modalTouchStartX + threshold) {
            // 右にスワイプ（前へ）
            if (currentIndex > 0) {
                sortEngine.changeCostumeDirect(side, currentIndex - 1);
                const modalImg = document.getElementById('modal-img');
                const costumeData = char.images[currentIndex - 1];
                modalImg.src = `src/img/${char.folder}/${costumeData.file}`;

                // クロップ位置適用
                const offsetX = costumeData.offsetX || 0;
                modalImg.style.objectPosition = `calc(50% + ${offsetX * 4}%) top`;

                // アニメーションを再トリガー
                modalImg.classList.remove('swipe-animate-left', 'swipe-animate-right');
                void modalImg.offsetWidth; // リフロー強制
                modalImg.classList.add('swipe-animate-right');
            }
        }
    }

    // --- PC向け：マウスホイールでの衣装切り替え ---
    modalEl.addEventListener('wheel', (e) => {
        const side = sortEngine.currentModalSide;
        if (!side) return;

        const nodes = sortEngine.currentQuestion;
        if (!nodes) return;

        const char = (side === 'left') ? nodes[0].character : nodes[1].character;
        if (!char || char.images.length <= 1) return;

        let currentIndex = sortEngine.currentCostumeIndices[side] || 0;
        const maxIndex = char.images.length - 1;

        // ホイールの回転量で次へ進むか戻るか判定
        if (e.deltaY > 0) {
            // 下にスクロール（次へ）
            if (currentIndex < maxIndex) {
                sortEngine.changeCostumeDirect(side, currentIndex + 1);
                const modalImg = document.getElementById('modal-img');
                const costumeData = char.images[currentIndex + 1];
                modalImg.src = `src/img/${char.folder}/${costumeData.file}`;

                const offsetX = costumeData.offsetX || 0;
                modalImg.style.objectPosition = `calc(50% + ${offsetX * 4}%) top`;

                modalImg.classList.remove('swipe-animate-left', 'swipe-animate-right');
                void modalImg.offsetWidth;
                modalImg.classList.add('swipe-animate-left');
            }
        } else if (e.deltaY < 0) {
            // 上にスクロール（前へ）
            if (currentIndex > 0) {
                sortEngine.changeCostumeDirect(side, currentIndex - 1);
                const modalImg = document.getElementById('modal-img');
                const costumeData = char.images[currentIndex - 1];
                modalImg.src = `src/img/${char.folder}/${costumeData.file}`;

                const offsetX = costumeData.offsetX || 0;
                modalImg.style.objectPosition = `calc(50% + ${offsetX * 4}%) top`;

                modalImg.classList.remove('swipe-animate-left', 'swipe-animate-right');
                void modalImg.offsetWidth;
                modalImg.classList.add('swipe-animate-right');
            }
        }
    });

}

// ------------------------------------
// 5. イベントリスナー全般登録
// ------------------------------------
document.addEventListener('keydown', (e) => {
    // バトル画面以外（スタート画面や結果画面、モーダル展開中）では無効
    const battleView = document.getElementById('battle-view');
    const modal = document.getElementById('image-modal');
    if (battleView.classList.contains('hidden')) return;
    if (modal && !modal.classList.contains('hidden')) return;

    // ソートが進行中でない場合は無効
    if (!sortEngine.currentQuestion) return;

    switch (e.key) {
        case 'ArrowLeft':
            e.preventDefault();
            sortEngine.select('left');
            break;
        case 'ArrowRight':
            e.preventDefault();
            sortEngine.select('right');
            break;
        case 'ArrowDown':
            e.preventDefault();
            sortEngine.skip();
            break;
        case 'ArrowUp':
            e.preventDefault();
            sortEngine.undo();
            break;
    }
});

function initChangelogModal() {
    const versionBadge = document.getElementById('version-info');
    const changelogModal = document.getElementById('changelog-modal');
    const closeChangelog = document.getElementById('close-changelog');
    const changelogContainer = document.getElementById('changelog-container');

    // 1. 最新バージョンのバッジ表示をデータから自動適用
    if (versionBadge && changelogData.length > 0) {
        versionBadge.innerText = changelogData[0].version; // 配列の先頭（最新）を表示
    }

    // 2. 更新履歴UIの動的生成
    if (changelogContainer && changelogData) {
        let htmlStr = '';
        changelogData.forEach(item => {
            htmlStr += `<div class="changelog-entry">`;
            htmlStr += `<h3>${item.version} <span style="font-size:12px; font-weight:normal; color:#666; margin-left:8px;">${item.date || ''}</span></h3>`;
            htmlStr += `<ul>`;
            item.contents.forEach(text => {
                htmlStr += `<li>${text}</li>`;
            });
            htmlStr += `</ul>`;
            htmlStr += `</div>`;
        });
        changelogContainer.innerHTML = htmlStr;
    }

    // 3. モーダル開閉イベント
    if (versionBadge && changelogModal) {
        versionBadge.addEventListener('click', () => {
            changelogModal.classList.remove('hidden');
        });
    }

    if (closeChangelog) {
        closeChangelog.addEventListener('click', () => {
            changelogModal.classList.add('hidden');
        });
    }

    if (changelogModal) {
        changelogModal.addEventListener('click', (e) => {
            if (e.target === changelogModal) {
                changelogModal.classList.add('hidden');
            }
        });
    }
}

// 各種ボタンのクリックイベント登録
function initButtonEvents() {
    // 拡大ボタン
    const btnExpandLeft = document.getElementById('btn-expand-left');
    if (btnExpandLeft) {
        btnExpandLeft.addEventListener('click', (e) => sortEngine.openModal('left', e));
    }
    const btnExpandRight = document.getElementById('btn-expand-right');
    if (btnExpandRight) {
        btnExpandRight.addEventListener('click', (e) => sortEngine.openModal('right', e));
    }

    // モーダル外/閉じるボタンクリック
    const imageModal = document.getElementById('image-modal');
    if (imageModal) {
        imageModal.addEventListener('click', () => sortEngine.closeModal());
    }

    // キャラクターカード自体のクリック
    const leftCard = document.getElementById('left-card');
    if (leftCard) {
        leftCard.addEventListener('click', () => sortEngine.select('left'));
    }
    const rightCard = document.getElementById('right-card');
    if (rightCard) {
        rightCard.addEventListener('click', () => sortEngine.select('right'));
    }

    // バトルコントロール（戻る・スキップ）
    const btnUndo = document.getElementById('btn-undo');
    if (btnUndo) btnUndo.addEventListener('click', () => sortEngine.undo());

    const btnSkip = document.getElementById('btn-skip');
    if (btnSkip) btnSkip.addEventListener('click', () => sortEngine.skip());

    // 除外コントロール
    const btnExcludeLeft = document.getElementById('btn-exclude-left');
    if (btnExcludeLeft) btnExcludeLeft.addEventListener('click', () => sortEngine.exclude('left'));

    const btnExcludeBoth = document.getElementById('btn-exclude-both');
    if (btnExcludeBoth) btnExcludeBoth.addEventListener('click', () => sortEngine.exclude('both'));

    const btnExcludeRight = document.getElementById('btn-exclude-right');
    if (btnExcludeRight) btnExcludeRight.addEventListener('click', () => sortEngine.exclude('right'));

    // 途中終了アクション
    const btnFinishEarly = document.getElementById('btn-finish-early');
    if (btnFinishEarly) btnFinishEarly.addEventListener('click', () => sortEngine.showResult());

    // 結果画面のアクション
    const shareBtn = document.getElementById('share-btn');
    if (shareBtn) shareBtn.addEventListener('click', () => sortEngine.shareResult());

    // フィルター系アクション
    const searchInput = document.getElementById('char-search-input');
    if (searchInput) searchInput.addEventListener('input', () => sortEngine.filterCharList());

    const btnAllOn = document.getElementById('btn-filter-all-on');
    if (btnAllOn) btnAllOn.addEventListener('click', () => sortEngine.toggleAllFilters(true));

    const btnAllOff = document.getElementById('btn-filter-all-off');
    if (btnAllOff) btnAllOff.addEventListener('click', () => sortEngine.toggleAllFilters(false));

    // ソート順変更用
    const listSort = document.getElementById('opt-list-sort');
    if (listSort) listSort.addEventListener('change', () => sortEngine.setupFilters());

    const restartBtn = document.getElementById('restart-btn');
    if (restartBtn) restartBtn.addEventListener('click', () => location.reload());

    // デバッグ用: F8キーでログコンテナを開閉
    document.addEventListener('keydown', (e) => {
        if (e.key === 'F8' || e.keyCode === 119) {
            const debugLog = document.getElementById('debug-log');
            if (debugLog) {
                debugLog.classList.toggle('hidden');
            }
        }
    });
}

function initApp() {
    initModalSwipe();
    initChangelogModal();
    initButtonEvents();

    // ソート開始ボタン
    const startBtn = document.getElementById('start-btn');
    if (startBtn) {
        startBtn.addEventListener('click', () => {
            sortEngine.init();
        });
    }

    // 初期化時にフィルターUIを構築する
    sortEngine.setupFilters();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initApp);
} else {
    initApp();
}
