-- Pin existing SECURITY DEFINER functions on databases where earlier
-- migrations have already been applied.
alter function public.get_emergency_card(uuid) set search_path = '';
alter function public.rate_limit_record_failure(text) set search_path = '';
alter function public.frequency_limit_check_and_increment(text, integer, integer)
  set search_path = '';
