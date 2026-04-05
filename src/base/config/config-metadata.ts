// ─── Config Key Metadata ───
//
// Rich metadata for each config key. Injected into LLM tool descriptions
// so the LLM can generate thorough explanations before changing settings.

export interface ConfigKeyMeta {
  label: string;
  description: string;
  type: "boolean" | "number" | "string";
  effects: string[];
  requirements: string[];
  risks: string[];
  revert: string;
  appliesAt: "next_session" | "immediate";
}

export const CONFIG_METADATA: Record<string, ConfigKeyMeta> = {
  daemon_mode: {
    label: "Daemon Mode",
    description: "CoreLoopをバックグラウンドdaemonとして実行するモード",
    type: "boolean",
    effects: [
      "CoreLoopがバックグラウンドdaemonプロセスとして常時動作する",
      "TUIを閉じてもゴールの実行が継続する",
      "TUIは『ウィンドウ』として何度でも再接続可能になる",
      "複数クライアント（TUI, Web UI）が同時にdaemonを監視できる",
    ],
    requirements: [
      "常時起動のPC（スリープしないこと）",
      "ポート41700が空いていること",
      "エージェント専用PCでの使用を推奨",
    ],
    risks: [
      "バックグラウンドでLLM APIを呼び続けるため、APIコストが継続的に発生する",
      "停止は pulseed daemon stop で明示的に行う必要がある",
      "PCがスリープするとdaemonも停止し、再起動が必要",
    ],
    revert: "pulseed config set daemon_mode false、または TUI内で /settings からOFFに切り替え",
    appliesAt: "next_session",
  },
};

/** Build a rich description string for a single config key. */
export function buildConfigKeyDescription(key: string): string {
  const m = CONFIG_METADATA[key];
  if (!m) return `Unknown config key: ${key}`;
  const bullet = (arr: string[]) => arr.map(s => `- ${s}`).join("\n");
  const timing = m.appliesAt === "next_session" ? "次のセッション（再起動後）から適用" : "即座に適用";
  return [`## ${m.label} (${key})`, m.description, "", "### 効果", bullet(m.effects), "",
    "### 必要な環境", bullet(m.requirements), "", "### リスク", bullet(m.risks), "",
    "### 元に戻す方法", m.revert, "", "### 適用タイミング", timing].join("\n");
}

/** Build the full tool description with all config keys' metadata injected. */
export function buildConfigToolDescription(): string {
  const descs = Object.keys(CONFIG_METADATA).map(k => buildConfigKeyDescription(k)).join("\n\n---\n\n");
  return ["PulSeedの設定を変更する。", "",
    "【重要ルール】このツールを呼ぶ前に、必ず以下の手順を踏むこと：",
    "1. 変更する設定の『効果』『必要な環境』『リスク』『元に戻す方法』『適用タイミング』をすべてユーザーに説明する",
    "2. ユーザーの明示的な同意（『はい』『OK』『大丈夫』等）を得る",
    "3. 同意を得てからこのツールを呼び出す",
    "4. 同意が得られない場合は呼び出さない", "",
    "【利用可能な設定キー】", "", descs].join("\n");
}
