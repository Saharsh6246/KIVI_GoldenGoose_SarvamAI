CREATE TABLE `dictation_chunks` (
	`id` text PRIMARY KEY NOT NULL,
	`dictation_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`text` text NOT NULL,
	`embedding` text,
	`tokens` integer,
	FOREIGN KEY (`dictation_id`) REFERENCES `dictations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `chunks_dictation_idx` ON `dictation_chunks` (`dictation_id`);--> statement-breakpoint
CREATE TABLE `dictations` (
	`id` text PRIMARY KEY NOT NULL,
	`spoken_at` integer NOT NULL,
	`app` text NOT NULL,
	`window_title` text,
	`recipient` text,
	`raw_asr` text NOT NULL,
	`formatted_text` text NOT NULL,
	`style_used` text,
	`duration_ms` integer,
	`lang` text DEFAULT 'en',
	`source` text DEFAULT 'import' NOT NULL,
	`corpus_id` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `dictations_spoken_at_idx` ON `dictations` (`spoken_at`);--> statement-breakpoint
CREATE INDEX `dictations_app_idx` ON `dictations` (`app`);--> statement-breakpoint
CREATE INDEX `dictations_corpus_idx` ON `dictations` (`corpus_id`);--> statement-breakpoint
CREATE TABLE `entities` (
	`id` text PRIMARY KEY NOT NULL,
	`canonical_name` text NOT NULL,
	`kind` text NOT NULL,
	`aliases` text DEFAULT '[]' NOT NULL,
	`summary` text,
	`status` text DEFAULT 'candidate' NOT NULL,
	`mention_count` integer DEFAULT 0 NOT NULL,
	`distinct_dictations` integer DEFAULT 0 NOT NULL,
	`confidence` real DEFAULT 0 NOT NULL,
	`first_seen` integer,
	`last_seen` integer,
	`reason` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `entities_name_idx` ON `entities` (`canonical_name`);--> statement-breakpoint
CREATE INDEX `entities_status_idx` ON `entities` (`status`);--> statement-breakpoint
CREATE TABLE `entity_facts` (
	`id` text PRIMARY KEY NOT NULL,
	`entity_id` text NOT NULL,
	`dictation_id` text NOT NULL,
	`claim` text NOT NULL,
	`state` text DEFAULT 'current' NOT NULL,
	`superseded_by` text,
	`spoken_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`entity_id`) REFERENCES `entities`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`dictation_id`) REFERENCES `dictations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `facts_entity_idx` ON `entity_facts` (`entity_id`);--> statement-breakpoint
CREATE INDEX `facts_dictation_idx` ON `entity_facts` (`dictation_id`);--> statement-breakpoint
CREATE TABLE `entity_mentions` (
	`id` text PRIMARY KEY NOT NULL,
	`entity_id` text NOT NULL,
	`dictation_id` text NOT NULL,
	`surface_form` text NOT NULL,
	`snippet` text NOT NULL,
	`spoken_at` integer NOT NULL,
	FOREIGN KEY (`entity_id`) REFERENCES `entities`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`dictation_id`) REFERENCES `dictations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `mentions_entity_idx` ON `entity_mentions` (`entity_id`);--> statement-breakpoint
CREATE INDEX `mentions_dictation_idx` ON `entity_mentions` (`dictation_id`);--> statement-breakpoint
CREATE TABLE `eval_results` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`case_id` text NOT NULL,
	`category` text NOT NULL,
	`question` text NOT NULL,
	`expectation` text NOT NULL,
	`interaction_id` text,
	`passed` integer NOT NULL,
	`verdict` text,
	`detail` text,
	`latency_ms` integer,
	`cost_usd` real DEFAULT 0,
	FOREIGN KEY (`run_id`) REFERENCES `eval_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `eval_results_run_idx` ON `eval_results` (`run_id`);--> statement-breakpoint
CREATE TABLE `eval_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`suite` text,
	`total_cases` integer DEFAULT 0,
	`passed` integer DEFAULT 0,
	`failed` integer DEFAULT 0,
	`cost_usd` real DEFAULT 0,
	`notes` text
);
--> statement-breakpoint
CREATE TABLE `ignored_records` (
	`id` text PRIMARY KEY NOT NULL,
	`dictation_id` text NOT NULL,
	`reason` text NOT NULL,
	`detail` text,
	`candidate` text,
	`stage` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`dictation_id`) REFERENCES `dictations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ignored_reason_idx` ON `ignored_records` (`reason`);--> statement-breakpoint
CREATE TABLE `ingest_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`label` text,
	`source_file` text,
	`records_seen` integer DEFAULT 0,
	`records_ingested` integer DEFAULT 0,
	`entities_created` integer DEFAULT 0,
	`entities_promoted` integer DEFAULT 0,
	`preferences_proposed` integer DEFAULT 0,
	`records_ignored` integer DEFAULT 0,
	`tokens_in` integer DEFAULT 0,
	`tokens_out` integer DEFAULT 0,
	`cost_usd` real DEFAULT 0,
	`db_bytes_before` integer,
	`db_bytes_after` integer,
	`wall_ms` integer
);
--> statement-breakpoint
CREATE TABLE `interaction_citations` (
	`id` text PRIMARY KEY NOT NULL,
	`interaction_id` text NOT NULL,
	`kind` text NOT NULL,
	`ref_id` text NOT NULL,
	`label` text,
	`rank` integer NOT NULL,
	`lexical_score` real DEFAULT 0,
	`vector_score` real DEFAULT 0,
	`score` real NOT NULL,
	`used` integer DEFAULT false NOT NULL,
	`note` text,
	FOREIGN KEY (`interaction_id`) REFERENCES `interactions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `citations_interaction_idx` ON `interaction_citations` (`interaction_id`);--> statement-breakpoint
CREATE TABLE `interactions` (
	`id` text PRIMARY KEY NOT NULL,
	`at` integer NOT NULL,
	`query` text NOT NULL,
	`app` text,
	`selection_text` text,
	`answer` text,
	`refused` integer DEFAULT false NOT NULL,
	`refusal_reason` text,
	`tool_calls` text DEFAULT '[]' NOT NULL,
	`top_score` real,
	`retrieval_ms` integer,
	`total_ms` integer,
	`model` text,
	`tokens_in` integer DEFAULT 0,
	`tokens_out` integer DEFAULT 0,
	`cost_usd` real DEFAULT 0,
	`eval_run_id` text
);
--> statement-breakpoint
CREATE INDEX `interactions_at_idx` ON `interactions` (`at`);--> statement-breakpoint
CREATE TABLE `memory_events` (
	`id` text PRIMARY KEY NOT NULL,
	`at` integer NOT NULL,
	`action` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`target_label` text,
	`source_dictation_id` text,
	`reason` text NOT NULL,
	`model` text,
	`tokens_in` integer DEFAULT 0,
	`tokens_out` integer DEFAULT 0,
	`cost_usd` real DEFAULT 0,
	`latency_ms` integer
);
--> statement-breakpoint
CREATE INDEX `events_target_idx` ON `memory_events` (`target_type`,`target_id`);--> statement-breakpoint
CREATE INDEX `events_at_idx` ON `memory_events` (`at`);--> statement-breakpoint
CREATE TABLE `phonetic_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`heard` text NOT NULL,
	`written` text NOT NULL,
	`times_applied` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `preference_evidence` (
	`id` text PRIMARY KEY NOT NULL,
	`preference_id` text NOT NULL,
	`dictation_id` text NOT NULL,
	`kind` text NOT NULL,
	`snippet` text NOT NULL,
	`spoken_at` integer NOT NULL,
	FOREIGN KEY (`preference_id`) REFERENCES `preferences`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`dictation_id`) REFERENCES `dictations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `pref_evidence_idx` ON `preference_evidence` (`preference_id`);--> statement-breakpoint
CREATE TABLE `preferences` (
	`id` text PRIMARY KEY NOT NULL,
	`scope_type` text NOT NULL,
	`scope_value` text,
	`statement` text NOT NULL,
	`status` text DEFAULT 'proposed' NOT NULL,
	`evidence_count` integer DEFAULT 0 NOT NULL,
	`confidence` real DEFAULT 0 NOT NULL,
	`reason` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`decided_at` integer
);
--> statement-breakpoint
CREATE INDEX `prefs_scope_idx` ON `preferences` (`scope_type`,`scope_value`);--> statement-breakpoint
CREATE TABLE `styles` (
	`id` text PRIMARY KEY NOT NULL,
	`app` text NOT NULL,
	`name` text NOT NULL,
	`instruction` text NOT NULL,
	`created_at` integer NOT NULL
);
