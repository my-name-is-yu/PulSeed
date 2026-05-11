import * as path from "node:path";
import { createHash } from "node:crypto";
import { PluginStateSchema, type PluginState } from "../types/plugin.js";
import {
  AssetRecordSchema,
  type AssetRecord,
} from "../assets/types.js";
import {
  CompatibilityReviewRecordSchema,
  ForeignPluginCompatibilityReportSchema,
  type CompatibilityReviewRecord,
  type ForeignPluginCompatibilityReport,
} from "../foreign-plugins/types.js";
import {
  openControlDatabase,
  type ControlDatabase,
  type RuntimeControlDbStoreOptions,
} from "./control-db/index.js";

export interface GatewayChannelHealth {
  last_inbound_at: string | null;
  last_outbound_at: string | null;
  last_error: string | null;
  last_timing?: GatewayChannelTimingSnapshot;
  updated_at: string;
}

export interface GatewayChannelTimingSnapshot {
  schema_version: "gateway-channel-timing-v1";
  channel: string;
  poll?: GatewayChannelPollTiming;
  turn?: GatewayChannelTurnTiming;
}

export interface GatewayChannelPollTiming {
  started_at: string;
  completed_at: string;
  duration_ms: number;
  offset: number;
  timeout_seconds: number;
  update_count: number;
  ok: boolean;
  error_class?: string;
}

export interface GatewayChannelTurnTiming {
  turn_ref: string;
  update_id?: number;
  message_id: number;
  inbound_admitted_at: string;
  dispatch_start_at?: string;
  chat_runner_execute_start_at?: string;
  route_selected_at?: string;
  first_model_request_started_at?: string;
  first_model_request_at?: string;
  first_model_delta_received_at?: string;
  first_model_delta_at?: string;
  first_assistant_event_at?: string;
  first_telegram_send_or_edit_attempted_at?: string;
  first_telegram_visible_text_confirmed_or_api_returned_at?: string;
  first_projected_assistant_text_at?: string;
  final_send_started_at?: string;
  final_send_completed_at?: string;
  typing_started_at?: string;
  typing_completed_at?: string;
  lifecycle_end_at?: string;
  first_typing_at?: string;
  first_progress_at?: string;
  first_final_at?: string;
  outbound_calls: GatewayChannelOutboundTiming[];
}

export interface GatewayChannelOutboundTiming {
  kind: string;
  started_at: string;
  completed_at: string;
  duration_ms: number;
  ok: boolean;
  error_class?: string;
}

export interface GatewayChannelBinding {
  home_target_id: string | null;
  first_bound_actor_id: string | null;
  updated_at: string;
}

export interface ImportedPluginCompatibilityArtifact {
  reportRef: string;
  reviewRecordRef: string;
  reviewRecord: CompatibilityReviewRecord;
}

export interface PluginChannelRuntimeStateStoreOptions extends RuntimeControlDbStoreOptions {}

function nowIso(): string {
  return new Date().toISOString();
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function stringifyJson(value: unknown): string {
  return JSON.stringify(value);
}

function stableRef(kind: string, value: string): string {
  const digest = createHash("sha256").update(path.resolve(value), "utf8").digest("hex").slice(0, 24);
  return `sqlite://pulseed-control/${kind}/${digest}`;
}

function normalizeChannelName(channelName: string): string {
  const normalized = channelName.trim();
  if (!normalized) throw new Error("Gateway channel name must be non-empty.");
  return normalized;
}

export class PluginChannelRuntimeStateStore {
  private dbPromise: Promise<ControlDatabase> | null = null;

  constructor(
    private readonly baseDir: string,
    private readonly options: PluginChannelRuntimeStateStoreOptions = {},
  ) {}

  async ensureReady(): Promise<void> {
    await this.database();
  }

  async savePluginState(state: PluginState): Promise<PluginState> {
    const parsed = PluginStateSchema.parse(state);
    const db = await this.database();
    const updatedAt = nowIso();
    db.transaction((sqlite) => {
      sqlite.prepare(`
        INSERT INTO plugin_runtime_states (
          plugin_name, status, manifest_name, manifest_version, manifest_type,
          loaded_at, updated_at, trust_score, usage_count, success_count, failure_count, state_json
        ) VALUES (
          @plugin_name, @status, @manifest_name, @manifest_version, @manifest_type,
          @loaded_at, @updated_at, @trust_score, @usage_count, @success_count, @failure_count, @state_json
        )
        ON CONFLICT(plugin_name) DO UPDATE SET
          status = excluded.status,
          manifest_name = excluded.manifest_name,
          manifest_version = excluded.manifest_version,
          manifest_type = excluded.manifest_type,
          loaded_at = excluded.loaded_at,
          updated_at = excluded.updated_at,
          trust_score = excluded.trust_score,
          usage_count = excluded.usage_count,
          success_count = excluded.success_count,
          failure_count = excluded.failure_count,
          state_json = excluded.state_json
      `).run({
        plugin_name: parsed.name,
        status: parsed.status,
        manifest_name: parsed.manifest.name,
        manifest_version: parsed.manifest.version,
        manifest_type: parsed.manifest.type,
        loaded_at: parsed.loaded_at,
        updated_at: updatedAt,
        trust_score: parsed.trust_score,
        usage_count: parsed.usage_count,
        success_count: parsed.success_count,
        failure_count: parsed.failure_count,
        state_json: stringifyJson(parsed),
      });
    });
    return parsed;
  }

  async loadPluginState(pluginName: string): Promise<PluginState | null> {
    const db = await this.database();
    return db.read((sqlite) => {
      const row = sqlite.prepare(`
        SELECT state_json
        FROM plugin_runtime_states
        WHERE plugin_name = ?
      `).get(pluginName) as { state_json: string } | undefined;
      return row ? PluginStateSchema.parse(parseJson(row.state_json)) : null;
    });
  }

  async saveChannelHealth(
    channelName: string,
    update: Partial<Pick<GatewayChannelHealth, "last_inbound_at" | "last_outbound_at" | "last_error" | "last_timing">>,
  ): Promise<GatewayChannelHealth> {
    const normalizedChannel = normalizeChannelName(channelName);
    const db = await this.database();
    const next = db.transaction((sqlite): GatewayChannelHealth => {
      const row = sqlite.prepare(`
        SELECT health_json
        FROM gateway_channel_health
        WHERE channel_name = ?
      `).get(normalizedChannel) as { health_json: string } | undefined;
      const current = row ? parseJson<GatewayChannelHealth>(row.health_json) : null;
      const merged: GatewayChannelHealth = {
        last_inbound_at: update.last_inbound_at ?? current?.last_inbound_at ?? null,
        last_outbound_at: update.last_outbound_at ?? current?.last_outbound_at ?? null,
        last_error: update.last_error !== undefined ? update.last_error : current?.last_error ?? null,
        last_timing: update.last_timing ?? current?.last_timing,
        updated_at: nowIso(),
      };
      sqlite.prepare(`
        INSERT INTO gateway_channel_health (
          channel_name, last_inbound_at, last_outbound_at, last_error, updated_at, health_json
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(channel_name) DO UPDATE SET
          last_inbound_at = excluded.last_inbound_at,
          last_outbound_at = excluded.last_outbound_at,
          last_error = excluded.last_error,
          updated_at = excluded.updated_at,
          health_json = excluded.health_json
      `).run(
        normalizedChannel,
        merged.last_inbound_at,
        merged.last_outbound_at,
        merged.last_error,
        merged.updated_at,
        stringifyJson(merged),
      );
      return merged;
    });
    return next;
  }

  async loadChannelHealth(channelName: string): Promise<GatewayChannelHealth | null> {
    const normalizedChannel = normalizeChannelName(channelName);
    const db = await this.database();
    return db.read((sqlite) => {
      const row = sqlite.prepare(`
        SELECT health_json
        FROM gateway_channel_health
        WHERE channel_name = ?
      `).get(normalizedChannel) as { health_json: string } | undefined;
      return row ? parseJson<GatewayChannelHealth>(row.health_json) : null;
    });
  }

  async saveChannelBinding(
    channelName: string,
    binding: Partial<Pick<GatewayChannelBinding, "home_target_id" | "first_bound_actor_id">>,
  ): Promise<GatewayChannelBinding> {
    const normalizedChannel = normalizeChannelName(channelName);
    const current = await this.loadChannelBinding(normalizedChannel);
    const next: GatewayChannelBinding = {
      home_target_id: binding.home_target_id !== undefined ? binding.home_target_id : current?.home_target_id ?? null,
      first_bound_actor_id: binding.first_bound_actor_id !== undefined
        ? binding.first_bound_actor_id
        : current?.first_bound_actor_id ?? null,
      updated_at: nowIso(),
    };
    const db = await this.database();
    db.transaction((sqlite) => {
      sqlite.prepare(`
        INSERT INTO gateway_channel_bindings (
          channel_name, home_target_id, first_bound_actor_id, updated_at, binding_json
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(channel_name) DO UPDATE SET
          home_target_id = excluded.home_target_id,
          first_bound_actor_id = excluded.first_bound_actor_id,
          updated_at = excluded.updated_at,
          binding_json = excluded.binding_json
      `).run(
        normalizedChannel,
        next.home_target_id,
        next.first_bound_actor_id,
        next.updated_at,
        stringifyJson(next),
      );
    });
    return next;
  }

  async loadChannelBinding(channelName: string): Promise<GatewayChannelBinding | null> {
    const normalizedChannel = normalizeChannelName(channelName);
    const db = await this.database();
    return db.read((sqlite) => {
      const row = sqlite.prepare(`
        SELECT binding_json
        FROM gateway_channel_bindings
        WHERE channel_name = ?
      `).get(normalizedChannel) as { binding_json: string } | undefined;
      return row ? parseJson<GatewayChannelBinding>(row.binding_json) : null;
    });
  }

  async saveForeignPluginCompatibility(
    pluginDir: string,
    report: ForeignPluginCompatibilityReport,
    reviewRecord: CompatibilityReviewRecord,
  ): Promise<ImportedPluginCompatibilityArtifact> {
    const parsedReport = ForeignPluginCompatibilityReportSchema.parse(report);
    const reportRef = stableRef("foreign-plugin-compatibility", pluginDir);
    const reviewRecordRef = stableRef("foreign-plugin-review", pluginDir);
    const parsedReview = CompatibilityReviewRecordSchema.parse({
      ...reviewRecord,
      report_ref: reportRef,
    });
    const db = await this.database();
    db.transaction((sqlite) => {
      sqlite.prepare(`
        INSERT INTO imported_plugin_compatibility_reports (
          plugin_dir, source, plugin_name, status, runtime_loadable, report_ref, recorded_at, report_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(plugin_dir) DO UPDATE SET
          source = excluded.source,
          plugin_name = excluded.plugin_name,
          status = excluded.status,
          runtime_loadable = excluded.runtime_loadable,
          report_ref = excluded.report_ref,
          recorded_at = excluded.recorded_at,
          report_json = excluded.report_json
      `).run(
        path.resolve(pluginDir),
        parsedReport.source,
        parsedReport.manifest?.name ?? "unknown",
        parsedReport.status,
        parsedReport.runtime_loadable ? 1 : 0,
        reportRef,
        parsedReview.created_at,
        stringifyJson(parsedReport),
      );
      sqlite.prepare(`
        INSERT INTO imported_plugin_review_records (
          plugin_dir, plugin_name, status, report_ref, review_ref,
          runtime_loadable, load_authority, created_at, reviewed_at, review_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(plugin_dir) DO UPDATE SET
          plugin_name = excluded.plugin_name,
          status = excluded.status,
          report_ref = excluded.report_ref,
          review_ref = excluded.review_ref,
          runtime_loadable = excluded.runtime_loadable,
          load_authority = excluded.load_authority,
          created_at = excluded.created_at,
          reviewed_at = excluded.reviewed_at,
          review_json = excluded.review_json
      `).run(
        path.resolve(pluginDir),
        parsedReview.plugin_name,
        parsedReview.status,
        reportRef,
        reviewRecordRef,
        parsedReview.runtime_loadable ? 1 : 0,
        parsedReview.load_authority,
        parsedReview.created_at,
        parsedReview.reviewed_at ?? null,
        stringifyJson(parsedReview),
      );
    });
    return { reportRef, reviewRecordRef, reviewRecord: parsedReview };
  }

  async loadForeignPluginCompatibility(pluginDir: string): Promise<ForeignPluginCompatibilityReport | null> {
    const db = await this.database();
    return db.read((sqlite) => {
      const row = sqlite.prepare(`
        SELECT report_json
        FROM imported_plugin_compatibility_reports
        WHERE plugin_dir = ?
      `).get(path.resolve(pluginDir)) as { report_json: string } | undefined;
      return row ? ForeignPluginCompatibilityReportSchema.parse(parseJson(row.report_json)) : null;
    });
  }

  async hasForeignPluginCompatibility(pluginDir: string): Promise<boolean> {
    const db = await this.database();
    return db.read((sqlite) => {
      const row = sqlite.prepare(`
        SELECT 1
        FROM imported_plugin_compatibility_reports
        WHERE plugin_dir = ?
        LIMIT 1
      `).get(path.resolve(pluginDir)) as { "1": number } | undefined;
      return row !== undefined;
    });
  }

  async loadAssetRecords(): Promise<AssetRecord[]> {
    const db = await this.database();
    return db.read((sqlite) => {
      const rows = sqlite.prepare(`
        SELECT asset_json
        FROM runtime_asset_records
        ORDER BY asset_id ASC
      `).all() as Array<{ asset_json: string }>;
      return rows.map((row) => AssetRecordSchema.parse(parseJson(row.asset_json)));
    });
  }

  async saveAssetRecords(records: AssetRecord[]): Promise<void> {
    const parsed = records.map((record) => AssetRecordSchema.parse(record));
    const db = await this.database();
    db.transaction((sqlite) => {
      const insert = sqlite.prepare(`
        INSERT INTO runtime_asset_records (
          asset_id, kind, status, source_agent, imported_path, updated_at, asset_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(asset_id) DO UPDATE SET
          kind = excluded.kind,
          status = excluded.status,
          source_agent = excluded.source_agent,
          imported_path = excluded.imported_path,
          updated_at = excluded.updated_at,
          asset_json = excluded.asset_json
      `);
      for (const record of parsed) {
        insert.run(
          record.id,
          record.kind,
          record.status,
          record.source_agent,
          record.imported_path ?? null,
          record.updated_at,
          stringifyJson(record),
        );
      }
    });
  }

  private async database(): Promise<ControlDatabase> {
    if (this.options.controlDb) return this.options.controlDb;
    this.dbPromise ??= openControlDatabase({
      baseDir: this.options.controlBaseDir ?? this.baseDir,
      dbPath: this.options.controlDbPath,
    });
    return this.dbPromise;
  }
}
