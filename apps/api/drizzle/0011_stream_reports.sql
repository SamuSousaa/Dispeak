CREATE TABLE "stream_reports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"channel_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"path" text NOT NULL,
	"codec" text,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"samples" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "stream_reports" ADD CONSTRAINT "stream_reports_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stream_reports" ADD CONSTRAINT "stream_reports_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stream_reports_user_idx" ON "stream_reports" USING btree ("user_id","started_at");--> statement-breakpoint
CREATE INDEX "stream_reports_channel_idx" ON "stream_reports" USING btree ("channel_id","started_at");