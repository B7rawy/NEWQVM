select public.apply_global_rls('shipping_carriers');
select public.apply_tenant_rls('entity_carrier_settings');
select public.apply_tenant_rls('drivers');
select public.apply_tenant_rls('shipments');
select public.apply_tenant_rls('driver_delivery_requests');
