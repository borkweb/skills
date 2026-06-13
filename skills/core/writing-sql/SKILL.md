---
name: writing-sql
description: >
  Use when writing, editing, reviewing, or discussing any SQL in the project.
  Triggers: SQL query, SELECT, INSERT, UPDATE, DELETE, CREATE TABLE, ALTER TABLE,
  migration, schema, database query, raw query, prepared statement, PDO, query builder,
  $wpdb, DB::, ->prepare(), ->query(), SQL formatting, inline SQL in PHP, CTE,
  subquery, window function, UNION, EXISTS. Applies to raw .sql files, migration DDL,
  inline queries in PHP adapters/repositories, and any code review involving SQL.
  Enforces project SQL formatting conventions — no exceptions for short queries.
user-invocable: false
model: sonnet
effort: low
---

# Writing SQL

## Overview

All SQL in this project follows a strict vertical formatting style: every top-level keyword on its own line, everything beneath it indented.

**No exceptions for short queries.** A one-column, one-table, one-condition query gets the same formatting as a 10-join monster.

## Rules

### Keyword Casing

All SQL keywords UPPERCASE: `SELECT`, `FROM`, `WHERE`, `JOIN`, `LEFT JOIN`, `RIGHT JOIN`, `CROSS JOIN`, `ON`, `AND`, `OR`, `NOT`, `IN`, `EXISTS`, `BETWEEN`, `LIKE`, `IS NULL`, `IS NOT NULL`, `INSERT INTO`, `VALUES`, `UPDATE`, `SET`, `DELETE FROM`, `ORDER BY`, `GROUP BY`, `HAVING`, `LIMIT`, `OFFSET`, `AS`, `CASE`, `WHEN`, `THEN`, `ELSE`, `END`, `UNION`, `UNION ALL`, `EXCEPT`, `INTERSECT`, `WITH`, `RECURSIVE`, `OVER`, `PARTITION BY`, `ROWS`, `RANGE`, `ON DUPLICATE KEY UPDATE`, `CREATE TABLE`, `ALTER TABLE`, `DROP TABLE`, `ADD COLUMN`, `DROP COLUMN`, `MODIFY COLUMN`, `DEFAULT`, `NOT NULL`, `PRIMARY KEY`, `FOREIGN KEY`, `REFERENCES`, `AUTO_INCREMENT`, `ENGINE`, `CHARSET`, `COLLATE`, `INDEX`, `UNIQUE KEY`, `IF EXISTS`, `IF NOT EXISTS`, `CASCADE`.

### Vertical Layout

Every top-level clause keyword sits **alone on its own line, flush left**. Everything belonging to that clause is indented one level (4 spaces) below it.

Top-level clause keywords: `SELECT`, `FROM`, `WHERE`, `ORDER BY`, `GROUP BY`, `HAVING`, `LIMIT`, `SET`, `VALUES`, `ON DUPLICATE KEY UPDATE`.

### Columns

One column per line, indented, trailing commas:

```sql
SELECT
    a.name,
    a.weight_kg,
    a.birth_date
```

### FROM and JOINs

JOINs are indented under `FROM`. `ON` is indented under the JOIN. Use bare `JOIN` for inner joins (the `INNER` keyword is redundant). Use explicit `LEFT JOIN` or `RIGHT JOIN` when an outer join is needed:

```sql
FROM
    animals a
    JOIN species s
        ON a.species_id = s.id
    LEFT JOIN habitats h
        ON a.habitat_id = h.id
```

Multi-condition JOINs — each condition on its own line with `AND` leading:

```sql
FROM
    animals a
    JOIN observations o
        ON a.id = o.animal_id
        AND o.observed_at >= :start_date
        AND o.status = 'confirmed'
```

### WHERE

First condition indented. Continuation lines at the same indent with `AND`/`OR` leading:

```sql
WHERE
    s.class = :class
    AND h.region = :region
    AND a.released_at IS NULL
```

### ORDER BY / GROUP BY

```sql
ORDER BY
    a.name ASC
GROUP BY
    s.id,
    h.name
```

### LIMIT / OFFSET

```sql
LIMIT
    :limit
OFFSET
    :offset
```

---

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

## DDL Statements

### CREATE TABLE (migrations)

```sql
CREATE TABLE IF NOT EXISTS animals (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    species_id BIGINT UNSIGNED NOT NULL,
    habitat_id BIGINT UNSIGNED NOT NULL,
    name VARCHAR(255) DEFAULT NULL,
    weight_kg DECIMAL(10, 2) DEFAULT NULL,
    birth_date DATE DEFAULT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    INDEX idx_species_id (species_id),
    INDEX idx_habitat_id (habitat_id),
    FOREIGN KEY (species_id) REFERENCES species (id) ON DELETE CASCADE,
    FOREIGN KEY (habitat_id) REFERENCES habitats (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

### ALTER TABLE

```sql
ALTER TABLE animals
    ADD COLUMN tag_number VARCHAR(50) DEFAULT NULL AFTER name,
    ADD INDEX idx_tag_number (tag_number);
```

### DROP TABLE

```sql
DROP TABLE IF EXISTS archive_sightings;
```

---

## SQL in PHP

### General Rule

When SQL is inside a quoted string, the opening and closing quotes go on their own lines. The SQL starts on the next line, indented one level from the quote. The closing quote sits at the same indent as the opening quote.

The SQL's "flush left" is one indent level in from the quote. Top-level clause keywords align there, and their contents indent one more level (4 spaces) from there.

### PDO with Prepared Statements (single-quoted string)

```php
$stmt = $this->pdo->prepare(
    '
        SELECT
            a.name,
            s.common_name
        FROM
            animals a
            JOIN species s
                ON a.species_id = s.id
        WHERE
            a.tag_id = :tag_id
    '
);
$stmt->execute(['tag_id' => $tagId]);
$rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
```

### PDO with Heredoc (for very long queries)

Heredocs are acceptable for queries long enough that the surrounding single quotes become hard to track. Same formatting rules apply inside the heredoc:

```php
$sql = <<<'SQL'
    SELECT
        a.name,
        s.common_name,
        h.region
    FROM
        animals a
        JOIN species s
            ON a.species_id = s.id
        LEFT JOIN habitats h
            ON a.habitat_id = h.id
    WHERE
        s.class = :class
        AND h.region = :region
    ORDER BY
        a.name ASC
SQL;

$stmt = $this->pdo->prepare($sql);
$stmt->execute([
    'class'  => $class,
    'region' => $region,
]);
```

### WordPress $wpdb

Use `$wpdb->prepare()` with `%s`, `%d`, `%f` placeholders. Same formatting rules. The `prepare()` call wraps the query string:

```php
$results = $wpdb->get_results(
    $wpdb->prepare(
        '
            SELECT
                p.ID,
                p.post_title,
                pm.meta_value AS custom_field
            FROM
                %i AS p
                LEFT JOIN %i AS pm
                    ON p.ID = pm.post_id
                    AND pm.meta_key = %s
            WHERE
                p.post_type = %s
                AND p.post_status = %s
            ORDER BY
                p.post_date DESC
            LIMIT
                %d
        ',
        $wpdb->posts,
        $wpdb->postmeta,
        'custom_key',
        'post',
        'publish',
        $limit
    )
);
```

### Laravel Query Builder / Eloquent Raw Expressions

When using `DB::select()`, `DB::statement()`, or `whereRaw()` / `selectRaw()`, the same formatting rules apply to the SQL string. Keep the raw SQL formatted vertically even inside a builder chain:

```php
$results = DB::select(
    '
        SELECT
            a.name,
            a.weight_kg
        FROM
            animals a
        WHERE
            a.species_id = ?
            AND a.weight_kg > ?
        ORDER BY
            a.weight_kg DESC
    ',
    [$speciesId, $minWeight]
);
```

```php
$query = Animal::query()
    ->whereRaw(
        '
            EXISTS (
                SELECT
                    1
                FROM
                    sightings s
                WHERE
                    s.animal_id = animals.id
                    AND s.observed_at >= ?
            )
        ',
        [$since]
    )
    ->orderBy('name');
```

### Building Queries Dynamically in PHP

When constructing SQL with conditional clauses, keep each fragment formatted as if it were part of the full query. Collect fragments in an array and join them:

```php
$clauses = [];
$params  = [];

$sql = '
    SELECT
        a.name,
        a.weight_kg
    FROM
        animals a
    WHERE
        1 = 1
';

if ($speciesId !== null) {
    $sql .= '
        AND a.species_id = :species_id
    ';
    $params['species_id'] = $speciesId;
}

if ($minWeight !== null) {
    $sql .= '
        AND a.weight_kg >= :min_weight
    ';
    $params['min_weight'] = $minWeight;
}

$sql .= '
    ORDER BY
        a.name ASC
';

$stmt = $this->pdo->prepare($sql);
$stmt->execute($params);
```

---

## Quick Reference

| Element | Rule |
|---|---|
| Keywords | Always UPPERCASE |
| Top-level clauses | Own line, flush left |
| Clause contents | Indented 4 spaces |
| Columns | One per line, trailing comma |
| JOINs | Indented under FROM; bare `JOIN` for inner, `LEFT`/`RIGHT` for outer |
| ON conditions | Indented under JOIN; multi-condition with AND leading |
| AND/OR | Leads the continuation line, same indent as first condition |
| Subqueries | Indented inside parens; closing paren aligns with opening line |
| CTEs | `WITH name AS (` on one line; body indented; comma after `)` between CTEs |
| CASE | WHEN/THEN/ELSE/END each indented under CASE |
| Window functions | OVER on same line as function; PARTITION BY/ORDER BY indented inside |
| UNION / set ops | Flush left, blank line above and below |
| Short queries | Same rules, no exceptions |
| PHP strings | Opening/closing quotes on own lines; SQL indented one level in |
| Heredocs | Acceptable for very long queries; same formatting inside |
| Dynamic SQL | Each appended fragment formatted as if part of the full query |

## Common Mistakes

- Putting `FROM tablename` on one line instead of `FROM` alone then table indented
- Listing multiple columns on one line
- Leaving JOINs flush left instead of indented under FROM
- Inlining short queries as one-liners
- Writing `INNER JOIN` instead of just `JOIN` (the `INNER` keyword is redundant)
- Putting CASE/WHEN/END all on one line
- Flattening subqueries into the surrounding clause instead of indenting inside parens
- Forgetting to vertically format SQL inside `whereRaw()`, `DB::select()`, or `$wpdb->prepare()`
- Using double-quoted PHP strings for SQL (risks variable interpolation — use single quotes or heredocs)
- Putting `LIMIT 10` on one line instead of `LIMIT` alone then value indented
