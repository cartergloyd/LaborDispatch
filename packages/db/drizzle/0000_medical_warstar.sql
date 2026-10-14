CREATE TYPE "public"."appointment_status" AS ENUM('hold', 'requested', 'confirmed', 'cancelled', 'completed', 'no_show');--> statement-breakpoint
CREATE TYPE "public"."contact_method_kind" AS ENUM('phone', 'email');--> statement-breakpoint
CREATE TYPE "public"."conversation_channel" AS ENUM('sms', 'web_chat', 'demo', 'api');--> statement-breakpoint
CREATE TYPE "public"."conversation_status" AS ENUM('open', 'awaiting_user', 'awaiting_owner', 'handed_off', 'closed');--> statement-breakpoint
CREATE TYPE "public"."dispute_status" AS ENUM('open', 'under_review', 'resolved_for_customer', 'resolved_for_provider', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."estimate_status" AS ENUM('draft', 'sent', 'approved', 'rejected', 'expired');--> statement-breakpoint
CREATE TYPE "public"."fact_category" AS ENUM('roof', 'gutters', 'hvac', 'water_heater', 'plumbing', 'electrical', 'appliance', 'structure', 'access', 'general');--> statement-breakpoint
CREATE TYPE "public"."fact_source" AS ENUM('user_stated', 'owner_stated', 'technician_observed', 'document', 'public_record', 'system_derived', 'demo_generated');--> statement-breakpoint
CREATE TYPE "public"."invoice_status" AS ENUM('draft', 'sent', 'partially_paid', 'paid', 'disputed', 'void');--> statement-breakpoint
CREATE TYPE "public"."maintenance_kind" AS ENUM('completed', 'scheduled', 'recommended');--> statement-breakpoint
CREATE TYPE "public"."message_direction" AS ENUM('inbound', 'outbound', 'system');--> statement-breakpoint
CREATE TYPE "public"."offer_status" AS ENUM('pending', 'accepted', 'declined', 'expired', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."party_role" AS ENUM('owner', 'resident', 'tenant', 'property_manager', 'authorized_contact');--> statement-breakpoint
CREATE TYPE "public"."provider_status" AS ENUM('onboarding', 'active', 'suspended', 'offboarded');--> statement-breakpoint
CREATE TYPE "public"."trade" AS ENUM('plumbing', 'electrical', 'hvac', 'roofing', 'appliance_repair', 'general_handyman', 'pest_control', 'locksmith', 'landscaping', 'cleaning', 'other');--> statement-breakpoint
CREATE TYPE "public"."urgency" AS ENUM('emergency', 'urgent', 'routine', 'low');--> statement-breakpoint
CREATE TYPE "public"."verification_status" AS ENUM('unverified', 'pending', 'verified', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."work_order_status" AS ENUM('intake', 'needs_info', 'pending_owner_approval', 'ready_to_dispatch', 'offered', 'accepted', 'scheduled', 'in_progress', 'completed', 'invoiced', 'paid', 'cancelled', 'disputed', 'no_provider_available');--> statement-breakpoint
CREATE TABLE "appliances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"property_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"manufacturer" text,
	"model" text,
	"serial_number" text,
	"location_in_home" text,
	"installed_at" timestamp with time zone,
	"source" "fact_source" DEFAULT 'user_stated' NOT NULL,
	"confidence" numeric(3, 2) DEFAULT '0.50' NOT NULL,
	"notes" text,
	"retired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "appointments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"work_order_id" uuid NOT NULL,
	"provider_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"status" "appointment_status" DEFAULT 'hold' NOT NULL,
	"hold_expires_at" timestamp with time zone,
	"requested_by_person_id" uuid,
	"confirmed_by" text,
	"confirmed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancellation_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contact_methods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"person_id" uuid NOT NULL,
	"kind" "contact_method_kind" NOT NULL,
	"value" text NOT NULL,
	"status" "verification_status" DEFAULT 'unverified' NOT NULL,
	"last_verified_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"is_primary" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel" "conversation_channel" NOT NULL,
	"external_id" text,
	"external_account_id" text,
	"inbound_identifier" text,
	"contact_method_id" uuid,
	"person_id" uuid,
	"property_id" uuid,
	"work_order_id" uuid,
	"status" "conversation_status" DEFAULT 'open' NOT NULL,
	"state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "demo_scenarios" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"label" text NOT NULL,
	"variant" text DEFAULT 'A' NOT NULL,
	"scenario" jsonb NOT NULL,
	"conversation_id" uuid,
	"work_order_id" uuid,
	"outcome" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dispatch_offers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"work_order_id" uuid NOT NULL,
	"provider_id" uuid NOT NULL,
	"round" integer DEFAULT 1 NOT NULL,
	"status" "offer_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"responded_at" timestamp with time zone,
	"response_note" text,
	"proposed_windows" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "disputes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"raised_by_person_id" uuid,
	"status" "dispute_status" DEFAULT 'open' NOT NULL,
	"reason" text NOT NULL,
	"resolution" text,
	"owner_notified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "estimates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"work_order_id" uuid NOT NULL,
	"provider_id" uuid NOT NULL,
	"status" "estimate_status" DEFAULT 'draft' NOT NULL,
	"line_items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"total_cents" integer DEFAULT 0 NOT NULL,
	"notes" text,
	"approved_by_person_id" uuid,
	"approved_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"work_order_id" uuid NOT NULL,
	"provider_id" uuid NOT NULL,
	"bill_to_person_id" uuid,
	"status" "invoice_status" DEFAULT 'draft' NOT NULL,
	"line_items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"subtotal_cents" integer DEFAULT 0 NOT NULL,
	"tax_cents" integer DEFAULT 0 NOT NULL,
	"total_cents" integer DEFAULT 0 NOT NULL,
	"paid_cents" integer DEFAULT 0 NOT NULL,
	"issued_at" timestamp with time zone,
	"due_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"stripe_payment_intent_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "maintenance_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"property_id" uuid NOT NULL,
	"appliance_id" uuid,
	"work_order_id" uuid,
	"kind" "maintenance_kind" NOT NULL,
	"category" "fact_category" DEFAULT 'general' NOT NULL,
	"description" text NOT NULL,
	"performed_at" timestamp with time zone,
	"due_at" timestamp with time zone,
	"cost_cents" integer,
	"vendor_name" text,
	"source" "fact_source" DEFAULT 'user_stated' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"direction" "message_direction" NOT NULL,
	"body" text NOT NULL,
	"external_id" text,
	"llm_content" jsonb,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"amount_cents" integer NOT NULL,
	"method" text NOT NULL,
	"reference" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "people" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"display_name" text NOT NULL,
	"notes" text,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "properties" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"line1" text NOT NULL,
	"line2" text,
	"city" text NOT NULL,
	"state" text NOT NULL,
	"postal_code" text NOT NULL,
	"country" text DEFAULT 'US' NOT NULL,
	"lat" numeric(9, 6),
	"lng" numeric(9, 6),
	"nickname" text,
	"access_notes" text,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "property_facts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"property_id" uuid NOT NULL,
	"category" "fact_category" NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"source" "fact_source" NOT NULL,
	"confidence" numeric(3, 2) NOT NULL,
	"observed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"recorded_by_person_id" uuid,
	"notes" text,
	"superseded_by_id" uuid
);
--> statement-breakpoint
CREATE TABLE "property_parties" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"property_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"role" "party_role" NOT NULL,
	"is_billing_responsible" boolean DEFAULT false NOT NULL,
	"starts_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ends_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_availability" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_id" uuid NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "providers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_name" text NOT NULL,
	"contact_name" text,
	"phone" text,
	"email" text,
	"trades" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"service_postal_codes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"license_number" text,
	"license_verified_at" timestamp with time zone,
	"license_expires_at" timestamp with time zone,
	"insurance_carrier" text,
	"insurance_verified_at" timestamp with time zone,
	"insurance_expires_at" timestamp with time zone,
	"status" "provider_status" DEFAULT 'onboarding' NOT NULL,
	"rating" numeric(3, 2),
	"jobs_completed" integer DEFAULT 0 NOT NULL,
	"offer_webhook_url" text,
	"accepts_emergencies" boolean DEFAULT false NOT NULL,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verification_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contact_method_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "warranties" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"property_id" uuid NOT NULL,
	"appliance_id" uuid,
	"provider" text NOT NULL,
	"policy_number" text,
	"covers" text NOT NULL,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"document_url" text,
	"source" "fact_source" DEFAULT 'user_stated' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_order_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"work_order_id" uuid NOT NULL,
	"type" text NOT NULL,
	"actor" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"property_id" uuid NOT NULL,
	"reported_by_person_id" uuid,
	"billing_person_id" uuid,
	"conversation_id" uuid,
	"trade" "trade" NOT NULL,
	"urgency" "urgency" DEFAULT 'routine' NOT NULL,
	"status" "work_order_status" DEFAULT 'intake' NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"symptoms" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"troubleshooting_performed" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_large_project" boolean DEFAULT false NOT NULL,
	"requires_owner_approval" boolean DEFAULT false NOT NULL,
	"owner_approved_at" timestamp with time zone,
	"owner_approved_by_person_id" uuid,
	"assigned_provider_id" uuid,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "appliances" ADD CONSTRAINT "appliances_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_work_order_id_work_orders_id_fk" FOREIGN KEY ("work_order_id") REFERENCES "public"."work_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_requested_by_person_id_people_id_fk" FOREIGN KEY ("requested_by_person_id") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_methods" ADD CONSTRAINT "contact_methods_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_contact_method_id_contact_methods_id_fk" FOREIGN KEY ("contact_method_id") REFERENCES "public"."contact_methods"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demo_scenarios" ADD CONSTRAINT "demo_scenarios_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demo_scenarios" ADD CONSTRAINT "demo_scenarios_work_order_id_work_orders_id_fk" FOREIGN KEY ("work_order_id") REFERENCES "public"."work_orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch_offers" ADD CONSTRAINT "dispatch_offers_work_order_id_work_orders_id_fk" FOREIGN KEY ("work_order_id") REFERENCES "public"."work_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch_offers" ADD CONSTRAINT "dispatch_offers_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_raised_by_person_id_people_id_fk" FOREIGN KEY ("raised_by_person_id") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimates" ADD CONSTRAINT "estimates_work_order_id_work_orders_id_fk" FOREIGN KEY ("work_order_id") REFERENCES "public"."work_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimates" ADD CONSTRAINT "estimates_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimates" ADD CONSTRAINT "estimates_approved_by_person_id_people_id_fk" FOREIGN KEY ("approved_by_person_id") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_work_order_id_work_orders_id_fk" FOREIGN KEY ("work_order_id") REFERENCES "public"."work_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_bill_to_person_id_people_id_fk" FOREIGN KEY ("bill_to_person_id") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_records" ADD CONSTRAINT "maintenance_records_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_records" ADD CONSTRAINT "maintenance_records_appliance_id_appliances_id_fk" FOREIGN KEY ("appliance_id") REFERENCES "public"."appliances"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property_facts" ADD CONSTRAINT "property_facts_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property_facts" ADD CONSTRAINT "property_facts_recorded_by_person_id_people_id_fk" FOREIGN KEY ("recorded_by_person_id") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property_parties" ADD CONSTRAINT "property_parties_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property_parties" ADD CONSTRAINT "property_parties_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_availability" ADD CONSTRAINT "provider_availability_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_challenges" ADD CONSTRAINT "verification_challenges_contact_method_id_contact_methods_id_fk" FOREIGN KEY ("contact_method_id") REFERENCES "public"."contact_methods"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warranties" ADD CONSTRAINT "warranties_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warranties" ADD CONSTRAINT "warranties_appliance_id_appliances_id_fk" FOREIGN KEY ("appliance_id") REFERENCES "public"."appliances"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_order_events" ADD CONSTRAINT "work_order_events_work_order_id_work_orders_id_fk" FOREIGN KEY ("work_order_id") REFERENCES "public"."work_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_reported_by_person_id_people_id_fk" FOREIGN KEY ("reported_by_person_id") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_billing_person_id_people_id_fk" FOREIGN KEY ("billing_person_id") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_owner_approved_by_person_id_people_id_fk" FOREIGN KEY ("owner_approved_by_person_id") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "appliances_property_idx" ON "appliances" USING btree ("property_id");--> statement-breakpoint
CREATE INDEX "appointments_provider_time_idx" ON "appointments" USING btree ("provider_id","starts_at");--> statement-breakpoint
CREATE INDEX "appointments_wo_idx" ON "appointments" USING btree ("work_order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "contact_methods_active_value_uq" ON "contact_methods" USING btree ("kind","value") WHERE "contact_methods"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "contact_methods_person_idx" ON "contact_methods" USING btree ("person_id");--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_external_uq" ON "conversations" USING btree ("channel","external_account_id","external_id");--> statement-breakpoint
CREATE INDEX "conversations_person_idx" ON "conversations" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "dispatch_offers_wo_idx" ON "dispatch_offers" USING btree ("work_order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "dispatch_offers_wo_provider_round_uq" ON "dispatch_offers" USING btree ("work_order_id","provider_id","round");--> statement-breakpoint
CREATE INDEX "invoices_wo_idx" ON "invoices" USING btree ("work_order_id");--> statement-breakpoint
CREATE INDEX "maintenance_property_idx" ON "maintenance_records" USING btree ("property_id");--> statement-breakpoint
CREATE INDEX "messages_conversation_idx" ON "messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_external_uq" ON "messages" USING btree ("conversation_id","external_id") WHERE "messages"."external_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "properties_postal_idx" ON "properties" USING btree ("postal_code");--> statement-breakpoint
CREATE INDEX "property_facts_prop_key_idx" ON "property_facts" USING btree ("property_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "property_parties_active_uq" ON "property_parties" USING btree ("property_id","person_id","role") WHERE "property_parties"."ends_at" IS NULL;--> statement-breakpoint
CREATE INDEX "property_parties_person_idx" ON "property_parties" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "provider_availability_idx" ON "provider_availability" USING btree ("provider_id","starts_at");--> statement-breakpoint
CREATE INDEX "providers_status_idx" ON "providers" USING btree ("status");--> statement-breakpoint
CREATE INDEX "verification_challenges_cm_idx" ON "verification_challenges" USING btree ("contact_method_id");--> statement-breakpoint
CREATE INDEX "warranties_property_idx" ON "warranties" USING btree ("property_id");--> statement-breakpoint
CREATE INDEX "work_order_events_wo_idx" ON "work_order_events" USING btree ("work_order_id","created_at");--> statement-breakpoint
CREATE INDEX "work_orders_property_idx" ON "work_orders" USING btree ("property_id");--> statement-breakpoint
CREATE INDEX "work_orders_status_idx" ON "work_orders" USING btree ("status");