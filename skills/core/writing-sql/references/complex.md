## Complex Patterns

### Subqueries

Subqueries are indented one level inside their parentheses. The opening paren sits on the line that introduces the subquery. The closing paren aligns with the start of that line:

**Subquery in WHERE:**

```sql
SELECT
    a.name,
    a.weight_kg
FROM
    animals a
WHERE
    a.species_id IN (
        SELECT
            s.id
        FROM
            species s
        WHERE
            s.class = :class
    )
```

**Subquery in FROM (derived table):**

```sql
SELECT
    top_species.common_name,
    top_species.animal_count
FROM
    (
        SELECT
            s.common_name,
            COUNT(a.id) AS animal_count
        FROM
            species s
            JOIN animals a
                ON s.id = a.species_id
        GROUP BY
            s.id,
            s.common_name
        HAVING
            COUNT(a.id) > :min_count
    ) AS top_species
ORDER BY
    top_species.animal_count DESC
```

**Scalar subquery in SELECT:**

```sql
SELECT
    a.name,
    (
        SELECT
            COUNT(*)
        FROM
            sightings s
        WHERE
            s.animal_id = a.id
    ) AS sighting_count
FROM
    animals a
```

### Common Table Expressions (CTEs)

`WITH` is flush left. Each CTE name and `AS` sit on the same line. The CTE body is indented inside parentheses. Separate multiple CTEs with a comma after the closing paren:

```sql
WITH recent_sightings AS (
    SELECT
        s.animal_id,
        s.location,
        s.observed_at
    FROM
        sightings s
    WHERE
        s.observed_at >= :since
),
animal_counts AS (
    SELECT
        rs.animal_id,
        COUNT(*) AS sighting_count
    FROM
        recent_sightings rs
    GROUP BY
        rs.animal_id
)
SELECT
    a.name,
    ac.sighting_count,
    rs.location AS last_location
FROM
    animal_counts ac
    JOIN animals a
        ON ac.animal_id = a.id
    JOIN recent_sightings rs
        ON a.id = rs.animal_id
ORDER BY
    ac.sighting_count DESC
```

### CASE Expressions

`CASE` starts on the column line. `WHEN`, `THEN`, `ELSE`, and `END` are each indented one level under `CASE`:

```sql
SELECT
    a.name,
    CASE
        WHEN a.weight_kg > 1000 THEN 'large'
        WHEN a.weight_kg > 100 THEN 'medium'
        ELSE 'small'
    END AS size_category,
    a.birth_date
FROM
    animals a
```

### Window Functions

The `OVER` clause stays on the same line as the function. `PARTITION BY` and `ORDER BY` inside the window are each on their own indented line:

```sql
SELECT
    a.name,
    a.weight_kg,
    ROW_NUMBER() OVER (
        PARTITION BY
            a.species_id
        ORDER BY
            a.weight_kg DESC
    ) AS weight_rank,
    AVG(a.weight_kg) OVER (
        PARTITION BY
            a.species_id
    ) AS avg_species_weight
FROM
    animals a
```

### UNION / UNION ALL / EXCEPT / INTERSECT

Set operators sit flush left on their own line, with a blank line above and below for readability:

```sql
SELECT
    a.name,
    'resident' AS status
FROM
    animals a
WHERE
    a.released_at IS NULL

UNION ALL

SELECT
    a.name,
    'released' AS status
FROM
    animals a
WHERE
    a.released_at IS NOT NULL
ORDER BY
    name ASC
```

### EXISTS

```sql
SELECT
    s.common_name
FROM
    species s
WHERE
    EXISTS (
        SELECT
            1
        FROM
            animals a
        WHERE
            a.species_id = s.id
            AND a.weight_kg > :min_weight
    )
```

---
