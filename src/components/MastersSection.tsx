"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * 店舗・キャストの台帳（管理画面の 1 節）。
 *
 * 仕様書 4.8 は「マージ承認 UI は IT に詳しくないスタッフでも操作できること。
 * 専門用語を画面へ出さない」としている。ここも同じ考えで、
 * 行をそのまま編集して保存するだけの作りにする。
 *
 * ★ 改名・削除しても、過去のセッションの記録（jobs の店舗名・キャスト名）は変わらない。
 *   記録は文字列で「当時の名前」を持っている。
 */

type Store = { id: string; name: string; sort_order: number; active: boolean; jobs: number };
type Cast = {
  id: string;
  store_id: string;
  name: string;
  joined_ym: string | null;
  note: string | null;
  active: boolean;
  source: string;
  label: string;
  jobs: number;
};

export function MastersSection() {
  const [stores, setStores] = useState<Store[]>([]);
  const [casts, setCasts] = useState<Cast[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [newStore, setNewStore] = useState("");
  const [newCast, setNewCast] = useState({ store_id: "", name: "", joined_ym: "", note: "" });
  const [filterStore, setFilterStore] = useState<string>("");

  // 編集中の行（1 行ずつ）
  const [editingStore, setEditingStore] = useState<Store | null>(null);
  const [editingCast, setEditingCast] = useState<Cast | null>(null);

  const reload = useCallback(async () => {
    const response = await fetch("/api/admin/masters", { cache: "no-store" });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.ok) {
      setError(data?.message ?? "台帳を読み込めませんでした。");
      return;
    }
    setError(null);
    setStores(data.stores ?? []);
    setCasts(data.casts ?? []);
    if (!newCast.store_id && data.stores?.[0]) {
      setNewCast((c) => ({ ...c, store_id: data.stores[0].id }));
    }
  }, [newCast.store_id]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function call(method: "POST" | "PATCH" | "DELETE", body: Record<string, unknown>, done: string) {
    setBusy(true);
    setNotice(null);
    setError(null);
    const response = await fetch("/api/admin/masters", {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => null);
    setBusy(false);
    if (!response.ok || !data?.ok) {
      setError(data?.message ?? "保存できませんでした。");
      return false;
    }
    setNotice(done);
    await reload();
    return true;
  }

  const storeName = (id: string) => stores.find((s) => s.id === id)?.name ?? "—";
  const visibleCasts = casts.filter((c) => !filterStore || c.store_id === filterStore);

  return (
    <>
      {error && <div className="invite-result error">{error}</div>}
      {notice && <div className="invite-result">{notice}</div>}

      {/* ── 店舗 ── */}
      <div className="settings-section-title">
        店舗 <span className="sec-badge">{stores.length} 件</span>
      </div>
      <div className="setting-note">
        加工画面の「店舗名」の候補になります。無効にすると候補から消えますが、過去の記録には残ります。
      </div>

      <form
        className="masters-add"
        onSubmit={(e) => {
          e.preventDefault();
          if (!newStore.trim()) return;
          void call("POST", { kind: "store", name: newStore.trim(), sort_order: stores.length + 1 }, "店舗を追加しました。").then(
            (ok) => ok && setNewStore(""),
          );
        }}
      >
        <input
          type="text"
          placeholder="新しい店舗名"
          value={newStore}
          onChange={(e) => setNewStore(e.target.value)}
          maxLength={60}
        />
        <button type="submit" className="crb-btn primary" disabled={busy || !newStore.trim()}>
          <i className="fa-solid fa-plus" /> 店舗を追加
        </button>
      </form>

      <div className="tablewrap">
        <table className="log-table masters-table">
          <thead>
            <tr>
              <th>店舗名</th>
              <th>表示順</th>
              <th>有効</th>
              <th>キャスト</th>
              <th>使用回数</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {stores.length === 0 && (
              <tr>
                <td colSpan={6}>店舗がありません。上の欄から追加してください。</td>
              </tr>
            )}
            {stores.map((store) =>
              editingStore?.id === store.id ? (
                <tr key={store.id} className="editing">
                  <td>
                    <input
                      type="text"
                      value={editingStore.name}
                      maxLength={60}
                      onChange={(e) => setEditingStore({ ...editingStore, name: e.target.value })}
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      className="narrow"
                      value={editingStore.sort_order}
                      onChange={(e) => setEditingStore({ ...editingStore, sort_order: Number(e.target.value) })}
                    />
                  </td>
                  <td>
                    <input
                      type="checkbox"
                      checked={editingStore.active}
                      onChange={(e) => setEditingStore({ ...editingStore, active: e.target.checked })}
                    />
                  </td>
                  <td>{casts.filter((c) => c.store_id === store.id).length} 人</td>
                  <td>{store.jobs} 回</td>
                  <td className="row-actions">
                    <button
                      type="button"
                      className="crb-btn primary"
                      disabled={busy}
                      onClick={() =>
                        void call(
                          "PATCH",
                          { kind: "store", id: store.id, name: editingStore.name, sort_order: editingStore.sort_order, active: editingStore.active },
                          "店舗を保存しました。",
                        ).then((ok) => ok && setEditingStore(null))
                      }
                    >
                      保存
                    </button>
                    <button type="button" className="crb-btn ghost" onClick={() => setEditingStore(null)}>
                      やめる
                    </button>
                  </td>
                </tr>
              ) : (
                <tr key={store.id} className={store.active ? "" : "inactive"}>
                  <td>{store.name}</td>
                  <td>{store.sort_order}</td>
                  <td>{store.active ? "✓" : "—"}</td>
                  <td>{casts.filter((c) => c.store_id === store.id).length} 人</td>
                  <td>{store.jobs} 回</td>
                  <td className="row-actions">
                    <button type="button" className="crb-btn ghost" onClick={() => setEditingStore(store)}>
                      <i className="fa-solid fa-pen" /> 編集
                    </button>
                    <button
                      type="button"
                      className="crb-btn ghost danger"
                      disabled={busy}
                      onClick={() => {
                        const n = casts.filter((c) => c.store_id === store.id).length;
                        if (
                          !confirm(
                            `「${store.name}」を削除します。${n > 0 ? `所属するキャスト ${n} 人も一緒に削除されます。` : ""}\n過去のセッションの記録は残ります。よろしいですか？`,
                          )
                        )
                          return;
                        void call("DELETE", { kind: "store", id: store.id }, "店舗を削除しました。");
                      }}
                    >
                      <i className="fa-solid fa-trash" /> 削除
                    </button>
                  </td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      </div>

      {/* ── キャスト ── */}
      <div className="settings-section-title">
        キャスト <span className="sec-badge">{casts.length} 人</span>
      </div>
      <div className="setting-note">
        表示名は「<strong>名前_入店年月</strong>」（仕様書 4.8）。Drive の保存先フォルダ名もこれになります。
        同じ店舗・同じ名前・同じ入店年月は登録できません（同月入店の同名は名前で区別してください）。
      </div>

      <form
        className="masters-add cast"
        onSubmit={(e) => {
          e.preventDefault();
          if (!newCast.store_id || !newCast.name.trim()) return;
          void call("POST", { kind: "cast", ...newCast, name: newCast.name.trim() }, "キャストを追加しました。").then(
            (ok) => ok && setNewCast((c) => ({ ...c, name: "", joined_ym: "", note: "" })),
          );
        }}
      >
        <select value={newCast.store_id} onChange={(e) => setNewCast({ ...newCast, store_id: e.target.value })}>
          {stores.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <input
          type="text"
          placeholder="キャスト名（源氏名）"
          value={newCast.name}
          maxLength={60}
          onChange={(e) => setNewCast({ ...newCast, name: e.target.value })}
        />
        <input
          type="month"
          title="入店年月"
          value={newCast.joined_ym}
          onChange={(e) => setNewCast({ ...newCast, joined_ym: e.target.value })}
        />
        <input
          type="text"
          placeholder="メモ（任意）"
          value={newCast.note}
          maxLength={200}
          onChange={(e) => setNewCast({ ...newCast, note: e.target.value })}
        />
        <button type="submit" className="crb-btn primary" disabled={busy || !newCast.name.trim() || !newCast.store_id}>
          <i className="fa-solid fa-user-plus" /> 追加
        </button>
      </form>

      <div className="masters-filter">
        <label>
          店舗で絞る：
          <select value={filterStore} onChange={(e) => setFilterStore(e.target.value)}>
            <option value="">すべて</option>
            {stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="tablewrap">
        <table className="log-table masters-table">
          <thead>
            <tr>
              <th>表示名</th>
              <th>店舗</th>
              <th>入店年月</th>
              <th>メモ</th>
              <th>有効</th>
              <th>使用回数</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {visibleCasts.length === 0 && (
              <tr>
                <td colSpan={7}>キャストがいません。上の欄から追加するか、加工画面の「新規キャストを登録」から登録できます。</td>
              </tr>
            )}
            {visibleCasts.map((cast) =>
              editingCast?.id === cast.id ? (
                <tr key={cast.id} className="editing">
                  <td>
                    <input
                      type="text"
                      value={editingCast.name}
                      maxLength={60}
                      onChange={(e) => setEditingCast({ ...editingCast, name: e.target.value })}
                    />
                  </td>
                  <td>
                    <select
                      value={editingCast.store_id}
                      onChange={(e) => setEditingCast({ ...editingCast, store_id: e.target.value })}
                    >
                      {stores.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <input
                      type="text"
                      className="narrow"
                      placeholder="YYYYMM"
                      value={editingCast.joined_ym ?? ""}
                      maxLength={7}
                      onChange={(e) => setEditingCast({ ...editingCast, joined_ym: e.target.value })}
                    />
                  </td>
                  <td>
                    <input
                      type="text"
                      value={editingCast.note ?? ""}
                      maxLength={200}
                      onChange={(e) => setEditingCast({ ...editingCast, note: e.target.value })}
                    />
                  </td>
                  <td>
                    <input
                      type="checkbox"
                      checked={editingCast.active}
                      onChange={(e) => setEditingCast({ ...editingCast, active: e.target.checked })}
                    />
                  </td>
                  <td>{cast.jobs} 回</td>
                  <td className="row-actions">
                    <button
                      type="button"
                      className="crb-btn primary"
                      disabled={busy}
                      onClick={() =>
                        void call(
                          "PATCH",
                          {
                            kind: "cast",
                            id: cast.id,
                            name: editingCast.name,
                            store_id: editingCast.store_id,
                            joined_ym: editingCast.joined_ym ?? "",
                            note: editingCast.note ?? "",
                            active: editingCast.active,
                          },
                          "キャストを保存しました。",
                        ).then((ok) => ok && setEditingCast(null))
                      }
                    >
                      保存
                    </button>
                    <button type="button" className="crb-btn ghost" onClick={() => setEditingCast(null)}>
                      やめる
                    </button>
                  </td>
                </tr>
              ) : (
                <tr key={cast.id} className={cast.active ? "" : "inactive"}>
                  <td>{cast.label}</td>
                  <td>{storeName(cast.store_id)}</td>
                  <td>{cast.joined_ym ? `${cast.joined_ym.slice(0, 4)}-${cast.joined_ym.slice(4)}` : "—"}</td>
                  <td>{cast.note ?? ""}</td>
                  <td>{cast.active ? "✓" : "—"}</td>
                  <td>{cast.jobs} 回</td>
                  <td className="row-actions">
                    <button type="button" className="crb-btn ghost" onClick={() => setEditingCast(cast)}>
                      <i className="fa-solid fa-pen" /> 編集
                    </button>
                    <button
                      type="button"
                      className="crb-btn ghost danger"
                      disabled={busy}
                      onClick={() => {
                        if (!confirm(`「${cast.label}」を削除します。過去のセッションの記録は残ります。よろしいですか？`)) return;
                        void call("DELETE", { kind: "cast", id: cast.id }, "キャストを削除しました。");
                      }}
                    >
                      <i className="fa-solid fa-trash" /> 削除
                    </button>
                  </td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      </div>

      <div className="setting-note">
        ★ 改名・削除しても、過去のセッションの記録は「当時の名前」のまま残ります。
        Drive の保存先フォルダもフォルダ ID で追っているので、改名で紐付けは切れません（フォルダ名は Drive 側で手で直して構いません）。
      </div>
    </>
  );
}
