alter table public.bundles drop constraint bundles_manifest_check;

alter table public.bundles add constraint bundles_manifest_check check (
  jsonb_typeof(manifest) = 'object'
  and octet_length(convert_to(manifest::text, 'UTF8')) <= 4194304
);
