# Supabase Migrations

This folder tracks SQL applied to Supabase for the Alywillow Slidecart app.

## How to run
1. Open Supabase SQL Editor for your project.
2. Run each file in `supabase/migrations` in filename order.
3. After each successful run, append an entry in `supabase/applied.log`.

## Notes
- Migrations are idempotent (`IF NOT EXISTS` / safe checks) where practical.
- Keep this folder as source-of-truth for manual SQL applied in Supabase.
