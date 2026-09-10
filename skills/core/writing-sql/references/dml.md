## DML Statements

### INSERT

```sql
INSERT INTO sightings (
    animal_id,
    location,
    observed_at
)
VALUES (
    :animal_id,
    :location,
    :observed_at
)
ON DUPLICATE KEY UPDATE
    location = new.location,
    observed_at = new.observed_at
```

**INSERT … SELECT:**

```sql
INSERT INTO archive_sightings (
    animal_id,
    location,
    observed_at
)
SELECT
    s.animal_id,
    s.location,
    s.observed_at
FROM
    sightings s
WHERE
    s.observed_at < :cutoff_date
```

### UPDATE

```sql
UPDATE
    animals
SET
    habitat_id = :habitat_id
WHERE
    id = :id
```

### DELETE

```sql
DELETE FROM
    sightings
WHERE
    animal_id = :animal_id
    AND observed_at = :observed_at
```

---
