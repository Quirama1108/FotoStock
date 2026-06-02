alter table public.inventory_items
drop constraint if exists inventory_items_serial_key;

alter table public.inventory_items
add constraint inventory_items_created_by_serial_key unique (created_by, serial);
