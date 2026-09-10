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
