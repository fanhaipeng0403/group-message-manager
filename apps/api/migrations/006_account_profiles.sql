ALTER TABLE accounts ADD COLUMN display_name text;
ALTER TABLE accounts ADD COLUMN avatar_url text;

UPDATE accounts
SET display_name = CASE id
  WHEN 'account-1' THEN '小红助手'
  WHEN 'account-2' THEN '小明助手'
  WHEN 'account-3' THEN '小张助手'
  ELSE id
END,
avatar_url = CASE id
  WHEN 'account-1' THEN 'https://api.dicebear.com/10.x/lorelei/svg?seed=XiaoHongAssistant'
  WHEN 'account-2' THEN 'https://api.dicebear.com/10.x/lorelei/svg?seed=XiaoMingAssistant'
  WHEN 'account-3' THEN 'https://api.dicebear.com/10.x/lorelei/svg?seed=XiaoZhangAssistant'
  ELSE 'https://api.dicebear.com/10.x/lorelei/svg?seed=' || encode(sha256(id::bytea), 'hex')
END;

ALTER TABLE accounts ALTER COLUMN display_name SET NOT NULL;
