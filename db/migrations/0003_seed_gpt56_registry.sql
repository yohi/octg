WITH seed_metadata AS (
  SELECT '2026-08-11T00:00:00Z' AS updated_at
), seed_models (model, provider, complimentary_pool, enabled, fallback_model) AS (
  VALUES
    ('gpt-5.6-sol', 'openai', 'STANDARD', 1, NULL),
    ('gpt-5.6-terra', 'openai', 'STANDARD', 1, NULL),
    ('gpt-5.6-luna', 'openai', 'MINI', 1, NULL)
)
INSERT INTO model_registry (model, provider, complimentary_pool, enabled, fallback_model, updated_at)
SELECT seed_models.model, seed_models.provider, seed_models.complimentary_pool,
       seed_models.enabled, seed_models.fallback_model, seed_metadata.updated_at
FROM seed_models
CROSS JOIN seed_metadata;
