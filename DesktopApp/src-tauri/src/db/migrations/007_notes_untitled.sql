UPDATE notes SET content = CASE
  WHEN trim(title, ' ' || char(9) || char(10) || char(13)) = '' THEN content
  WHEN content = '' THEN title
  ELSE title || char(10) || content
END;
UPDATE notes SET title = '';
INSERT OR IGNORE INTO schema_version(version) VALUES (7);
