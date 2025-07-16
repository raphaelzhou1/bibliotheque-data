-- Insert admin user into auth.users
INSERT INTO auth.users (
    instance_id,
    id,
    aud,
    role,
    email,
    encrypted_password,
    email_confirmed_at,
    recovery_sent_at,
    last_sign_in_at,
    raw_app_meta_data,
    raw_user_meta_data,
    created_at,
    updated_at,
    confirmation_token,
    email_change,
    email_change_token_new,
    recovery_token
) (
    SELECT
        '00000000-0000-0000-0000-000000000000',
        uuid_generate_v4(),
        'authenticated',
        'authenticated',
        'zhoutianyu0426@gmail.com',
        crypt('cccccc', gen_salt('bf')),
        current_timestamp,
        current_timestamp,
        current_timestamp,
        '{"provider":"email","providers":["email"]}',
        '{}',
        current_timestamp,
        current_timestamp,
        '',
        '',
        '',
        ''
    FROM generate_series(1, 1)
);

-- Insert admin user profile
INSERT INTO profiles (id, display_name, role) 
VALUES (
  (SELECT id FROM auth.users WHERE email = 'zhoutianyu0426@gmail.com'),
  'Admin User',
  'admin'
) ON CONFLICT (id) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  role = EXCLUDED.role;
