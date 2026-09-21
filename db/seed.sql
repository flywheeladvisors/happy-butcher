-- Seed data: the household's stores (Cary, NC) and watch list. Idempotent.
-- zip is what the Flipp weekly-ad lookup is scoped by; store_number is the chain's own location id.

insert into public.stores (name, city, state, zip, store_number, base_url, weekly_ad_url) values
  ('Harris Teeter', 'Cary', 'NC', '27513', '09700112', 'https://www.harristeeter.com', 'https://www.harristeeter.com/specials/weeklyad'),     -- Harrison Pointe, 270 Grande Heights Dr
  ('Food Lion',     'Cary', 'NC', '27513', null,       'https://www.foodlion.com',     'https://www.foodlion.com/savings/weekly-ad/grid-view'), -- Parkway Point, 2458 SW Cary Pkwy
  ('Lowes Foods',   'Cary', 'NC', '27513', '162',      'https://www.lowesfoods.com',   'https://weeklyad.lowesfoods.com'),                    -- Cary Tryon, 6430 Tryon Rd
  ('ALDI',          'Cary', 'NC', '27513', null,       'https://www.aldi.us',          'https://www.aldi.us/store/aldi/flyers/view/weekly/print'), -- 2303 NW Maynard Rd
  ('LIDL',          'Cary', 'NC', '27513', null,       'https://www.lidl.com',         'https://www.lidl.com/c/offers-leaflets/s10092873'),   -- 1105 N Harrison Ave
  ('Publix',        'Cary', 'NC', '27519', '1552',     'https://www.publix.com',       'https://www.publix.com/savings/weekly-ad/view-all?setstorenumber=1552') -- Amberly Place, 425 Emissary Dr
on conflict do nothing;

insert into public.watch_items (name) values
  ('NY strip steaks'), ('London broil'), ('Ribeye steaks'), ('Filet mignon / beef tenderloin'),
  ('Chicken breasts'), ('Chicken thighs (boneless)'),
  ('Pork shoulder'), ('Picnic roast'), ('Pork loin'), ('Pork tenderloin'), ('Marinated pork tenderloin'), ('Boneless pork chops')
on conflict do nothing;
