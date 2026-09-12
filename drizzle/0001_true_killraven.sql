ALTER TABLE `dictations` ADD `processed_at` integer;--> statement-breakpoint
CREATE INDEX `dictations_processed_idx` ON `dictations` (`processed_at`);