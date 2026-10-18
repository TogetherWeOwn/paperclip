-- Operational ALL_ASSIGNED denominator, including selections that never became
-- enrollments. Bind $1 = company UUID and $2 = endpoint UUID. One row per arm,
-- not per delivery. Projection retries and native candidate deliveries cannot
-- double-count an assignment. NULL/missing candidate assessments remain missing.
with assignments as (
  select d.id as origin_delivery_id, d.company_id, d.endpoint_id,
    d.normalized_event->'githubPairingSeed'->>'id' as enrollment_id,
    arm->>'id' as arm_id,
    d.normalized_event ? 'githubPairingFailure'
      and not (d.normalized_event ? 'githubPairingPending')
      and not (d.normalized_event ? 'githubPairingSeed') as capture_failed
  from chat_deliveries d
  cross join lateral jsonb_array_elements(coalesce(
    d.normalized_event->'githubPairingSeed'->'arms',
    d.normalized_event->'githubPairingPending'->'arms',
    d.normalized_event->'githubPairingFailure'->'arms', '[]'::jsonb
  )) arm
  where d.company_id = $1::uuid and d.endpoint_id = $2::uuid
    and d.github_shadow_label is null
), outcomes as (
  select a.*, exists (
    select 1 from chat_github_review_candidates c
    join chat_github_reviews r on r.company_id = c.company_id
      and r.endpoint_id = c.endpoint_id and r.delivery_id = c.native_delivery_id::text
      and r.shadow_label = c.shadow_label
    where c.company_id = a.company_id and c.endpoint_id = a.endpoint_id
      and c.enrollment_id::text = a.enrollment_id and c.arm_id::text = a.arm_id
      and r.assessment is not null
  ) as has_assessment
  from assignments a
)
select count(*) as assigned_pairs,
  count(*) filter (where not has_assessment) as missing_pairs,
  count(*) filter (where capture_failed) as capture_failed_pairs
from outcomes;
