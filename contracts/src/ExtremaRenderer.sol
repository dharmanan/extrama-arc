// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

interface IExtremaPoolMetadata {
    struct TicketMetadata {
        uint256 roundId;
        uint64 predictionPriceCents;
        uint64 entrySequence;
        uint8 roundStatus;
        uint8 placement;
        bool isClaimed;
        bool isRefunded;
    }

    function ASSET() external view returns (uint8);
    function DIRECTION() external view returns (uint8);
    function CADENCE() external view returns (uint8);
    function getTicketMetadata(uint256 ticketId) external view returns (TicketMetadata memory);
}

contract ExtremaRenderer {
    struct RenderContext {
        IExtremaPoolMetadata.TicketMetadata metadata;
        uint8 asset;
        uint8 direction;
        uint8 cadence;
        uint256 tokenId;
    }

    function tokenURI(
        address pool,
        uint256 tokenId
    ) external view returns (string memory) {
        IExtremaPoolMetadata source = IExtremaPoolMetadata(pool);

        RenderContext memory context = RenderContext({
            metadata: source.getTicketMetadata(tokenId),
            asset: source.ASSET(),
            direction: source.DIRECTION(),
            cadence: source.CADENCE(),
            tokenId: tokenId
        });

        string memory svg = _renderSvg(context);
        string memory image = string.concat(
            "data:image/svg+xml;base64,",
            _base64(bytes(svg))
        );

        return string.concat(
            "data:application/json;base64,",
            _base64(bytes(_renderJson(context, image)))
        );
    }

    function _renderSvg(
        RenderContext memory context
    ) internal pure returns (string memory) {
        return string.concat(
            _svgHeader(context),
            _svgPrediction(context),
            _svgDetails(context),
            _svgStatus(context)
        );
    }

    function _svgHeader(
        RenderContext memory context
    ) internal pure returns (string memory) {
        string memory assetName = _asset(context.asset);
        string memory directionName = context.direction == 0 ? "HIGH" : "LOW";
        string memory cadenceName = _cadence(context.cadence);
        string memory accent = _accent(context.direction);

        return string.concat(
            '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1200" viewBox="0 0 900 1200">',
            '<rect width="900" height="1200" rx="48" fill="',
            _background(context.asset),
            '"/>',
            '<rect x="44" y="44" width="812" height="1112" rx="36" fill="none" stroke="',
            accent,
            '" stroke-width="3"/>',
            '<text x="76" y="120" font-family="monospace" font-size="28" fill="#ffffff">EXTREMA</text>',
            '<text x="76" y="230" font-family="monospace" font-size="76" font-weight="700" fill="#ffffff">',
            assetName,
            '</text>',
            '<text x="760" y="230" text-anchor="end" font-family="monospace" font-size="80" fill="',
            accent,
            '">',
            context.direction == 0 ? "&#8593;" : "&#8595;",
            '</text>',
            '<text x="76" y="292" font-family="monospace" font-size="30" fill="',
            accent,
            '">',
            cadenceName,
            ' - ',
            directionName,
            '</text>'
        );
    }

    function _svgPrediction(
        RenderContext memory context
    ) internal pure returns (string memory) {
        return string.concat(
            '<text x="76" y="440" font-family="monospace" font-size="24" fill="#aeb4bd">PREDICTION</text>',
            '<text x="76" y="515" font-family="monospace" font-size="56" font-weight="700" fill="#ffffff">$',
            _formatCents(context.metadata.predictionPriceCents),
            '</text>',
            '<line x1="76" y1="585" x2="824" y2="585" stroke="#ffffff" stroke-opacity=".16"/>'
        );
    }

    function _svgDetails(
        RenderContext memory context
    ) internal pure returns (string memory) {
        return string.concat(
            '<text x="76" y="665" font-family="monospace" font-size="24" fill="#aeb4bd">ROUND</text>',
            '<text x="320" y="665" font-family="monospace" font-size="24" fill="#aeb4bd">TICKET</text>',
            '<text x="570" y="665" font-family="monospace" font-size="24" fill="#aeb4bd">ENTRY</text>',
            '<text x="76" y="715" font-family="monospace" font-size="34" fill="#ffffff">#',
            _toString(context.metadata.roundId),
            '</text>',
            '<text x="320" y="715" font-family="monospace" font-size="34" fill="#ffffff">#',
            _toString(context.tokenId),
            '</text>',
            '<text x="570" y="715" font-family="monospace" font-size="34" fill="#ffffff">#',
            _toString(context.metadata.entrySequence),
            '</text>'
        );
    }

    function _svgStatus(
        RenderContext memory context
    ) internal pure returns (string memory) {
        string memory accent = _accent(context.direction);
        string memory statusName = _status(
            context.metadata.roundStatus,
            context.metadata.placement,
            context.metadata.isClaimed,
            context.metadata.isRefunded
        );

        return string.concat(
            '<rect x="76" y="870" width="748" height="150" rx="28" fill="',
            accent,
            '" fill-opacity=".12"/>',
            '<text x="450" y="930" text-anchor="middle" font-family="monospace" font-size="22" fill="#aeb4bd">STATUS</text>',
            '<text x="450" y="985" text-anchor="middle" font-family="monospace" font-size="34" font-weight="700" fill="',
            accent,
            '">',
            statusName,
            '</text>',
            '<text x="76" y="1100" font-family="monospace" font-size="20" fill="#7f8792">ONCHAIN PREDICTION TICKET</text>',
            '</svg>'
        );
    }

    function _renderJson(
        RenderContext memory context,
        string memory image
    ) internal pure returns (string memory) {
        string memory assetName = _asset(context.asset);
        string memory directionName = context.direction == 0 ? "HIGH" : "LOW";
        string memory cadenceName = _cadence(context.cadence);
        string memory statusName = _status(
            context.metadata.roundStatus,
            context.metadata.placement,
            context.metadata.isClaimed,
            context.metadata.isRefunded
        );

        return string.concat(
            _jsonIdentity(
                context,
                image,
                assetName,
                directionName,
                cadenceName
            ),
            _jsonAttributes(
                context,
                assetName,
                directionName,
                cadenceName,
                statusName
            )
        );
    }

    function _jsonIdentity(
        RenderContext memory context,
        string memory image,
        string memory assetName,
        string memory directionName,
        string memory cadenceName
    ) internal pure returns (string memory) {
        return string.concat(
            '{"name":"EXTREMA ',
            assetName,
            ' ',
            cadenceName,
            ' ',
            directionName,
            ' #',
            _toString(context.tokenId),
            '","description":"Fully onchain EXTREMA prediction ticket.","image":"',
            image,
            '","attributes":['
        );
    }

    function _jsonAttributes(
        RenderContext memory context,
        string memory assetName,
        string memory directionName,
        string memory cadenceName,
        string memory statusName
    ) internal pure returns (string memory) {
        return string.concat(
            '{"trait_type":"Asset","value":"',
            assetName,
            '"},',
            '{"trait_type":"Direction","value":"',
            directionName,
            '"},',
            '{"trait_type":"Cadence","value":"',
            cadenceName,
            '"},',
            '{"trait_type":"Round","value":',
            _toString(context.metadata.roundId),
            '},',
            '{"trait_type":"Prediction Cents","value":',
            _toString(context.metadata.predictionPriceCents),
            '},',
            '{"trait_type":"Entry Sequence","value":',
            _toString(context.metadata.entrySequence),
            '},',
            '{"trait_type":"Status","value":"',
            statusName,
            '"}',
            ']}'
        );
    }

    function _asset(uint8 value) internal pure returns (string memory) {
        if (value == 0) return "BTC";
        if (value == 1) return "ETH";
        if (value == 2) return "SOL";
        return "HYPE";
    }

    function _cadence(uint8 value) internal pure returns (string memory) {
        if (value == 0) return "DAILY";
        if (value == 1) return "WEEKLY";
        return "QUARTERLY";
    }

    function _background(uint8 asset) internal pure returns (string memory) {
        if (asset == 0) return "#17120b";
        if (asset == 1) return "#11131b";
        if (asset == 2) return "#101713";
        return "#171016";
    }

    function _accent(uint8 direction) internal pure returns (string memory) {
        return direction == 0 ? "#d9f99d" : "#fda4af";
    }

    function _status(
        uint8 roundStatus,
        uint8 placement,
        bool isClaimed,
        bool isRefunded
    ) internal pure returns (string memory) {
        if (isClaimed) return "CLAIMED";
        if (isRefunded) return "REFUNDED";

        if (roundStatus == 0) return "LIVE";
        if (roundStatus == 1) return "LOCKED";
        if (roundStatus == 3) return "CANCELLED";

        if (placement == 1) return "WINNER - 1ST";
        if (placement == 2) return "WINNER - 2ND";
        if (placement == 3) return "WINNER - 3RD";

        return "SETTLED";
    }

    function _formatCents(uint256 cents) internal pure returns (string memory) {
        uint256 whole = cents / 100;
        uint256 fraction = cents % 100;

        return string.concat(
            _toString(whole),
            ".",
            fraction < 10 ? "0" : "",
            _toString(fraction)
        );
    }

    function _toString(uint256 value) internal pure returns (string memory) {
        if (value == 0) return "0";

        uint256 temp = value;
        uint256 digits;

        while (temp != 0) {
            ++digits;
            temp /= 10;
        }

        bytes memory buffer = new bytes(digits);

        while (value != 0) {
            --digits;
            buffer[digits] = bytes1(uint8(48 + uint256(value % 10)));
            value /= 10;
        }

        return string(buffer);
    }

    function _base64(bytes memory data) internal pure returns (string memory) {
        if (data.length == 0) return "";

        bytes memory table = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        uint256 encodedLen = 4 * ((data.length + 2) / 3);
        bytes memory result = new bytes(encodedLen);

        uint256 i;
        uint256 j;

        while (i < data.length) {
            uint256 a = uint8(data[i++]);
            uint256 b = i < data.length ? uint8(data[i++]) : 0;
            uint256 c = i < data.length ? uint8(data[i++]) : 0;
            uint256 triple = (a << 16) | (b << 8) | c;

            result[j++] = table[(triple >> 18) & 0x3F];
            result[j++] = table[(triple >> 12) & 0x3F];
            result[j++] = table[(triple >> 6) & 0x3F];
            result[j++] = table[triple & 0x3F];
        }

        uint256 mod = data.length % 3;
        if (mod == 1) {
            result[encodedLen - 1] = "=";
            result[encodedLen - 2] = "=";
        } else if (mod == 2) {
            result[encodedLen - 1] = "=";
        }

        return string(result);
    }
}
