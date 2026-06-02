alter table public.inventory_items
alter column created_by set not null;

alter table public.production_packages
alter column created_by set not null;
