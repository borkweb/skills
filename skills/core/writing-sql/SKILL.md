---
name: writing-sql
description: "Apply the project’s vertical SQL formatting when authoring or reviewing actual SQL, including migrations and embedded queries. No exception for short queries; generic database discussion does not activate it."

user-invocable: false
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

## Conditional examples

Read only the reference relevant to the SQL being written or reviewed:
- [Complex queries](references/complex.md): subqueries, CTEs, CASE, window functions and set operations.
- [DML](references/dml.md): INSERT, UPDATE and DELETE.
- [DDL](references/ddl.md): CREATE, ALTER and DROP in migrations.
- [SQL in PHP](references/php.md): PDO, heredoc, wpdb, Laravel and dynamic fragments.

SQL in host-language strings keeps this same vertical layout, including short queries. Preserve parameter binding and query semantics; formatting does not authorize query execution or schema changes.
