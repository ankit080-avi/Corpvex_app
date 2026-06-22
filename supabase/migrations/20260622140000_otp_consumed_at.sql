-- Track when an OTP was consumed by a successful ERP login, so the app can show
-- a "login successful" state and stop its countdown timer.
alter table public.otp_codes add column if not exists consumed_at timestamptz;
