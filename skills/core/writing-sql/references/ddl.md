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
