Community Data

Further links and information are available once you have signed up and logged into your account here
WARNING: The community XML data is deprecated. We recommend using the web APIs whenever possible.

Steam provides access to community data in an XML format that can be consumed by game developers and other community sites. It is important to note that a player's data might be unavailable if the player's privacy settings prevent the data from being exposed.

Player Profile
Information presented on a player's profile page is available using the player's 64-bit Steam ID with:
Format: http://steamcommunity.com/profiles/<SteamID>/?xml=1
Example: http://steamcommunity.com/profiles/76561197968575517/?xml=1
or using their Custom URL (set by the user in their profile):
Format: http://steamcommunity.com/id/<CustomURL>/?xml=1
Example: http://steamcommunity.com/id/ChetFaliszek/?xml=1

Player Game Stats
To retrieve game stats, you will need the game's Steam Community name. Developers can contact Valve to obtain the community name for their game.

You can retrieve stats and achievements for a player per game using the player's 64-bit Steam ID with:
Format: http://steamcommunity.com/profiles/<SteamID>/stats/<CommunityGameName>/?xml=1
Example: http://steamcommunity.com/profiles/76561197968575517/stats/L4D/?xml=1
or using their Custom URL (set by the user in their profile):
Format: http://steamcommunity.com/id/<CustomURL>/stats/<CommunityGameName>/?xml=1
Example: http://steamcommunity.com/id/ChetFaliszek/stats/L4D/?xml=1
Note: For most games, the Steam Community only exposes achievements a user has received. However, a player's game play stats are exposed for games that have a custom Steam Community stats page.

For games that are configured to expose raw stats data, you can retrieve stats for a user using their 64-bit Steam ID and the game's Application ID with:

Format: http://steamcommunity.com/profiles/<SteamID>/statsfeed/<AppID>/?xml=1&schema=1
Example: http://steamcommunity.com/profiles/76561197968575517/statsfeed/500/?xml=1&schema=1
or using their Custom URL (set by the user in their profile) and the game's Application ID with:
Format: http://steamcommunity.com/id/<CustomURL>/statsfeed/<AppID>/?xml=1&schema=1
Example: http://steamcommunity.com/id/ChetFaliszek/statsfeed/500/?xml=1&schema=1

Leaderboards
To retrieve entries for a leaderboard, you will need the leaderboard's ID. The ID for each leaderboard is returned in the list of leaderboards for a game.

You can retrieve the list of leaderboards for a game using the game's Steam Community name with:
Format: http://steamcommunity.com/stats/<CommunityGameName>/leaderboards/?xml=1
Example: http://steamcommunity.com/stats/L4D/leaderboards/?xml=1
You can retrieve all leaderboard entries created by friends of a player using the player's 64-bit Steam ID with:
Format: http://steamcommunity.com/stats/<CommunityGameName>/leaderboards/<LeaderboardID>/?xml=1&steamid=<SteamID>
Example: http://steamcommunity.com/stats/L4D/leaderboards/30/?xml=1&steamid=76561197968575517
You can retrieve a global range of leaderboard entries with (StartRange and EndRange are integers):
Format: http://steamcommunity.com/stats/<CommunityGameName>/leaderboards/<LeaderboardID>/?xml=1&start=<StartRange>&end=<EndRange>
Example (retrieves top 10): http://steamcommunity.com/stats/L4D/leaderboards/30/?xml=1&start=1&end=10

Groups
You can retrieve the list of members in a group by using the group's 64-bit Steam ID with:
Format: http://steamcommunity.com/gid/<GroupID>/memberslistxml/?xml=1
Example: http://steamcommunity.com/gid/103582791429521412/memberslistxml/?xml=1
or using the group's Steam Community name with:
Format: http://steamcommunity.com/groups/<GroupName>/memberslistxml/?xml=1
Example: http://steamcommunity.com/groups/Valve/memberslistxml/?xml=1

