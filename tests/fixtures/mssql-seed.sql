-- SQL Server test fixture (database datagrippe_test). Batches are separated by GO lines.

CREATE SCHEMA sales AUTHORIZATION dbo;
GO

CREATE TYPE dbo.email_address FROM nvarchar(320) NOT NULL;
GO

CREATE TYPE dbo.id_list AS TABLE (
    id int NOT NULL PRIMARY KEY,
    note nvarchar(50) NULL
);
GO

CREATE SEQUENCE dbo.invoice_seq AS bigint START WITH 1000 INCREMENT BY 10 MINVALUE 1000 MAXVALUE 999999999 NO CYCLE CACHE 20;
GO

CREATE TABLE dbo.customers (
    id int IDENTITY(1,1) NOT NULL CONSTRAINT PK_customers PRIMARY KEY CLUSTERED,
    email nvarchar(255) NOT NULL,
    full_name varchar(100) NULL,
    is_active bit NOT NULL CONSTRAINT DF_customers_is_active DEFAULT (1),
    credit_limit decimal(12,2) NULL,
    balance money NULL,
    created_at datetime2(7) NOT NULL CONSTRAINT DF_customers_created_at DEFAULT (SYSUTCDATETIME()),
    last_seen datetimeoffset(7) NULL,
    birth_date date NULL,
    preferred_time time(7) NULL,
    external_id uniqueidentifier NOT NULL CONSTRAINT DF_customers_external_id DEFAULT (NEWID()),
    avatar varbinary(max) NULL,
    profile xml NULL,
    settings nvarchar(max) NULL CONSTRAINT CK_customers_settings_json CHECK (settings IS NULL OR ISJSON(settings) = 1),
    display_name AS (COALESCE(full_name, CONVERT(varchar(100), email))),
    CONSTRAINT UQ_customers_email UNIQUE NONCLUSTERED (email)
);
GO

EXEC sys.sp_addextendedproperty @name = N'MS_Description', @value = N'People who buy things',
    @level0type = N'SCHEMA', @level0name = N'dbo', @level1type = N'TABLE', @level1name = N'customers';
EXEC sys.sp_addextendedproperty @name = N'MS_Description', @value = N'Login e-mail, unique',
    @level0type = N'SCHEMA', @level0name = N'dbo', @level1type = N'TABLE', @level1name = N'customers',
    @level2type = N'COLUMN', @level2name = N'email';
GO

CREATE TABLE sales.orders (
    id int IDENTITY(1000,1) NOT NULL CONSTRAINT PK_orders PRIMARY KEY CLUSTERED,
    customer_id int NOT NULL,
    status varchar(20) NOT NULL CONSTRAINT DF_orders_status DEFAULT ('new'),
    total decimal(14,2) NOT NULL CONSTRAINT DF_orders_total DEFAULT (0),
    ordered_at datetime2(3) NOT NULL CONSTRAINT DF_orders_ordered_at DEFAULT (SYSUTCDATETIME()),
    updated_at datetime2(3) NULL,
    CONSTRAINT FK_orders_customers FOREIGN KEY (customer_id) REFERENCES dbo.customers (id) ON DELETE CASCADE,
    CONSTRAINT CK_orders_status CHECK (status IN ('new', 'paid', 'shipped', 'cancelled')),
    CONSTRAINT CK_orders_total CHECK (total >= 0)
);
GO

CREATE NONCLUSTERED INDEX IX_orders_customer ON sales.orders (customer_id ASC, ordered_at DESC)
    INCLUDE (total, status) WHERE status <> 'cancelled';
GO

-- No SET NOCOUNT on purpose: data-editor row counts must ignore rows touched by triggers.
CREATE TRIGGER sales.trg_orders_touch ON sales.orders AFTER UPDATE AS
BEGIN
    UPDATE o SET updated_at = SYSUTCDATETIME()
    FROM sales.orders o JOIN inserted i ON i.id = o.id;
END;
GO

CREATE TABLE sales.order_items (
    order_id int NOT NULL,
    line_no smallint NOT NULL,
    product nvarchar(100) NOT NULL,
    quantity int NOT NULL CONSTRAINT CK_order_items_quantity CHECK (quantity > 0),
    unit_price decimal(10,2) NOT NULL,
    CONSTRAINT PK_order_items PRIMARY KEY CLUSTERED (order_id, line_no),
    CONSTRAINT FK_order_items_orders FOREIGN KEY (order_id) REFERENCES sales.orders (id) ON DELETE CASCADE
);
GO

CREATE TABLE dbo.audit_log (
    id bigint IDENTITY(1,1) NOT NULL,
    happened_at datetime NOT NULL CONSTRAINT DF_audit_log_happened_at DEFAULT (GETDATE()),
    actor dbo.email_address NULL,
    action nvarchar(50) NOT NULL,
    payload nvarchar(max) NULL,
    row_version rowversion NOT NULL
);
GO

CREATE TABLE dbo.big_numbers (
    id int NOT NULL CONSTRAINT PK_big_numbers PRIMARY KEY,
    big bigint NULL,
    exact decimal(38,10) NULL,
    amount money NULL,
    small_amount smallmoney NULL,
    ratio float NULL,
    single real NULL,
    tiny tinyint NULL,
    small smallint NULL,
    legacy_dt datetime NULL,
    small_dt smalldatetime NULL,
    fixed_bin binary(4) NULL,
    variant sql_variant NULL
);
GO

CREATE TABLE dbo.events (
    id int NOT NULL CONSTRAINT PK_events PRIMARY KEY,
    kind varchar(20) NOT NULL,
    payload nvarchar(200) NULL,
    created_at datetime2(0) NOT NULL
);
GO

CREATE TABLE dbo.[Mixed Case Table] (
    [Id] int NOT NULL CONSTRAINT [PK_Mixed Case Table] PRIMARY KEY,
    [Weird Column] nvarchar(50) NULL,
    [order] int NULL
);
GO

CREATE VIEW dbo.active_customers AS
SELECT id, email, full_name, credit_limit
FROM dbo.customers
WHERE is_active = 1;
GO

CREATE PROCEDURE sales.archive_orders
    @before datetime2,
    @dry_run bit = 1,
    @archived int OUTPUT
AS
BEGIN
    SET NOCOUNT ON;
    SELECT @archived = COUNT(*) FROM sales.orders WHERE ordered_at < @before AND status = 'shipped';
    IF @dry_run = 0
        UPDATE sales.orders SET status = 'cancelled' WHERE ordered_at < @before AND status = 'shipped';
END;
GO

CREATE FUNCTION sales.customer_total (@customer_id int)
RETURNS decimal(14,2)
AS
BEGIN
    RETURN (SELECT COALESCE(SUM(total), 0) FROM sales.orders WHERE customer_id = @customer_id);
END;
GO

CREATE FUNCTION sales.orders_since (@since datetime2)
RETURNS TABLE
AS
RETURN SELECT id, customer_id, status, total, ordered_at FROM sales.orders WHERE ordered_at >= @since;
GO

SET IDENTITY_INSERT dbo.customers ON;
INSERT INTO dbo.customers (id, email, full_name, is_active, credit_limit, balance, created_at, last_seen, birth_date,
    preferred_time, external_id, avatar, profile, settings)
VALUES
    (1, N'ada@example.com', 'Ada Lovelace', 1, 1500.50, 1234.5678, '2024-01-15 10:30:00.1234567',
     '2024-01-15 10:30:00.1234567 +02:00', '1815-12-10', '08:15:30.1234567', '6F9619FF-8B86-D011-B42D-00C04FC964FF',
     0x0102ABCDEF, N'<profile><lang>en</lang></profile>', N'{"theme":"dark","beta":true}'),
    (2, N'grace@example.com', 'Grace Hopper', 1, 99999.99, -42.0001, '2023-06-01 00:00:00', NULL, '1906-12-09',
     NULL, 'A0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11', NULL, NULL, NULL),
    (3, N'linus@example.com', NULL, 0, NULL, NULL, '2022-02-02 02:02:02.0000001', '2022-02-02 23:30:00 -05:30', NULL,
     '23:59:59.9999999', 'C56A4180-65AA-42EC-A945-5FD21DEC0538', 0x, NULL, N'[]');
SET IDENTITY_INSERT dbo.customers OFF;
GO

SET IDENTITY_INSERT sales.orders ON;
INSERT INTO sales.orders (id, customer_id, status, total, ordered_at)
VALUES
    (1000, 1, 'paid', 120.00, '2024-02-01 09:00:00'),
    (1001, 1, 'shipped', 75.25, '2024-02-03 12:00:00'),
    (1002, 2, 'new', 10.00, '2024-03-01 08:30:00'),
    (1003, 2, 'cancelled', 0.00, '2024-03-02 08:30:00');
SET IDENTITY_INSERT sales.orders OFF;
GO

INSERT INTO sales.order_items (order_id, line_no, product, quantity, unit_price)
VALUES
    (1000, 1, N'Keyboard', 1, 100.00),
    (1000, 2, N'Mouse pad', 2, 10.00),
    (1001, 1, N'Cable', 3, 25.08),
    (1002, 1, N'Sticker', 5, 2.00);
GO

INSERT INTO dbo.audit_log (happened_at, actor, action, payload)
VALUES
    ('2024-01-01 12:00:00.123', N'ada@example.com', N'login', NULL),
    ('2024-01-01 12:05:00', NULL, N'export', N'{"rows":3}');
GO

INSERT INTO dbo.big_numbers (id, big, exact, amount, small_amount, ratio, single, tiny, small, legacy_dt, small_dt, fixed_bin, variant)
VALUES
    (1, 9223372036854775807, 1234567890123456789012345678.1234567891, 922337203685477.5807, 214748.3647,
     0.1, 1.5, 255, 32767, '2024-05-06 07:08:09.997', '2024-05-06 07:08:00', 0xDEADBEEF, CAST(CAST(42 AS int) AS sql_variant)),
    (2, -9223372036854775808, -0.0000000001, -922337203685477.5808, -214748.3648,
     -1.7976931348623157E308, -3.25, 0, -32768, '1753-01-01 00:00:00', '1900-01-01 00:00:00', 0x00000001, CAST(N'text' AS sql_variant)),
    (3, 0, 0, 0, 0, 0, 0, NULL, NULL, NULL, NULL, NULL, NULL);
GO

WITH n AS (
    SELECT TOP (10000) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS i
    FROM sys.all_objects a CROSS JOIN sys.all_objects b
)
INSERT INTO dbo.events (id, kind, payload, created_at)
SELECT i,
       CASE i % 3 WHEN 0 THEN 'click' WHEN 1 THEN 'view' ELSE 'purchase' END,
       CONCAT(N'event #', i),
       DATEADD(SECOND, i, CAST('2024-01-01' AS datetime2(0)))
FROM n;
GO

INSERT INTO dbo.[Mixed Case Table] ([Id], [Weird Column], [order])
VALUES (1, N'first', 10), (2, N'second', 20), (3, NULL, NULL);
GO
