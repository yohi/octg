UPDATE model_registry
SET complimentary_pool = 'MINI',
    updated_at = '2026-08-21T00:00:00Z'
WHERE model = 'gpt-5.6-terra'
  AND provider = 'openai';
